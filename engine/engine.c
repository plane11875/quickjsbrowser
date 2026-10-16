// engine.c — QuickJS 2026-06-04 wasm 壳（C ABI，无 Rust）
//
// 架构：DO 宿主(JS) ⇄ C ABI(qjs_*) ⇄ QuickJS。
// 事件模型：JS→宿主只有一条出口 __hostEnqueue(kind, payloadJson)（发后即忘，
// 无栈悬挂——不走 asyncify）；宿主→JS 只有 qjs_call_global("__dispatch", json)。
// ESM：同步 loader 查 C 侧源码表（qjs_add_module_source 预填，宿主代抓整张
// import 图后才开始求值）；动态 import() 仅命中已预取 URL，未命中即拒绝并留痕。
//
// 导入面：wasi_snapshot_preview1 的 7 个桩（clock_time_get/fd_close/fd_seek/
// fd_write/fd_prestat_get/fd_prestat_dir_name/proc_exit，src/engine.js 提供）。
// Date 原生走 clock_time_get。

#include "quickjs.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>

#define MAX_SOURCES 2048
#define MAX_MODCACHE 2048
/* outbox 必须容得下一次 eval 里"同步"产生的全部日志。页面脚本一次 eval 中
   打 >MAX_OUTBOX 行日志是很常见的（调试 bundle / 循环里 console.log）：
   旧值 1024 时 __hostEnqueue 抛 "outbox full"，直接把页面脚本打断
   （实测 2000 行 → rc=1，脚本中途夭折）。改大上限 + 溢出改为丢弃并计数，
   不再打断脚本。 */
#define MAX_OUTBOX 65536

#define SRC_KIND_JS 0
#define SRC_KIND_JSON 1

typedef struct { char *url; char *src; int kind; } SrcEntry;
typedef struct { char *url; JSModuleDef *m; } ModEntry;
typedef struct { char *base; char *name; char *url; } Resolution;

static struct {
    JSRuntime *rt;
    JSContext *ctx;
    SrcEntry sources[MAX_SOURCES];
    int nsrc;
    ModEntry modcache[MAX_MODCACHE];
    int nmod;
    struct { JSValue promise, reason; } rejections[64];
    int nrejections;
    Resolution resolutions[4096];
    int nres;
    int scope_locked;
    uint32_t scope_max_source, scope_total_source, scope_compiled;
    unsigned long saved_interrupt_budget;
    char *outbox[MAX_OUTBOX];
    int nout;
    unsigned long outbox_dropped;   /* 溢出丢弃计数，随 outbox 一起上报 */
    unsigned long interrupt_budget;
    unsigned long interrupt_count;
    unsigned char *input;   /* qjs_alloc 输入缓冲 */
    size_t input_cap;       /* input 已分配容量（复用，避免大载荷反复 malloc） */
    size_t input_len;
    char *out_buf;          /* 打包输出缓冲 */
    size_t out_cap;
} S;

/* ---------------- 打包输出 (len<<32)|ptr ---------------- */

static uint64_t pack_out(const char *s, size_t len) {
    if (len + 1 > S.out_cap) {
        size_t cap = S.out_cap ? S.out_cap : 4096;
        while (cap < len + 1) cap *= 2;
        free(S.out_buf);
        S.out_buf = malloc(cap);
        S.out_cap = cap;
    }
    memcpy(S.out_buf, s, len);
    S.out_buf[len] = 0;
    return ((uint64_t)len << 32) | (uint32_t)(uintptr_t)S.out_buf;
}

static uint64_t pack_str(const char *s) { return pack_out(s, strlen(s)); }

/* ---------------- outbox（JS→宿主任务） ---------------- */

/* 溢出不再抛异常打断页面脚本，改为丢弃并计数；计数在 qjs_take_tasks 时
   以 outbox_dropped 任务上报，宿主能看见"日志被截断"而不是静默丢失。 */
static int outbox_push(const char *kind, const char *payload_json) {
    if (S.nout >= MAX_OUTBOX) { S.outbox_dropped++; return -2; }
    size_t klen = strlen(kind);
    size_t plen = payload_json ? strlen(payload_json) : 4;
    char *buf = malloc(klen + plen + 24);
    if (!buf) { S.outbox_dropped++; return -1; }
    memcpy(buf, "{\"kind\":\"", 9);
    memcpy(buf + 9, kind, klen);
    memcpy(buf + 9 + klen, "\",\"payload\":", 12);
    if (payload_json) memcpy(buf + 21 + klen, payload_json, plen);
    else memcpy(buf + 21 + klen, "null", 4);
    buf[21 + klen + plen] = '}';
    buf[22 + klen + plen] = 0;   /* strlen 依赖：无终结符会越界读堆垃圾 */
    S.outbox[S.nout++] = buf;
    return 0;
}

/* 页面 JS 的唯一出口（prelude.js 封装后页面只见 fetch/setTimeout/...）。
   kind 由 prelude 白名单产生，无需转义；payload 已是 JSON 文本。 */
static JSValue js_enqueue(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
    (void)this_val;
    const char *kind = JS_ToCString(ctx, argv[0]);
    if (!kind) return JS_EXCEPTION;
    const char *payload = NULL;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        payload = JS_ToCString(ctx, argv[1]);
        if (!payload) { JS_FreeCString(ctx, kind); return JS_EXCEPTION; }
    }
    int rc = outbox_push(kind, payload);
    JS_FreeCString(ctx, kind);
    if (payload) JS_FreeCString(ctx, payload);
    /* -2 = 队列满，丢弃即可；页面脚本继续跑。只有 malloc 失败才算致命。 */
    if (rc == -1) return JS_ThrowInternalError(ctx, "outbox oom");
    return JS_UNDEFINED;
}

// A synchronous read-only host call; it may run renderer WASM but never reenters QuickJS.
__attribute__((import_module("browser"), import_name("layout")))
extern int browser_layout(const char *input, uint32_t length, char *output, uint32_t capacity);
static JSValue js_layout(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t len=0; const char *input=JS_ToCStringLen(ctx,&len,argv[0]);
    if(!input)return JS_EXCEPTION;
    const uint32_t cap=65536; char *output=malloc(cap);
    if(!output){JS_FreeCString(ctx,input);return JS_ThrowOutOfMemory(ctx);}
    int count=browser_layout(input,(uint32_t)len,output,cap);
    JS_FreeCString(ctx,input);
    if(count>=0 && count<(int)cap)output[count]=0;else count=-1;
    JSValue result=count<0?JS_ThrowInternalError(ctx,"layout bridge failed"):JS_ParseJSON(ctx,output,count,"<layout>");
    free(output); return result;
}

/* ---------------- 异常序列化 ---------------- */

/* 取已挂异常 → outbox {kind:"exception",payload:{message,stack}}，返回文本副本供调用方 */
static JSValue error_field(JSContext *ctx, JSValueConst exc,const char *key,const char *fallback) {
    JSValue v=JS_IsObject(exc)?JS_GetPropertyStr(ctx,exc,key):JS_UNDEFINED;
    if(JS_IsException(v)){JS_FreeValue(ctx,JS_GetException(ctx));v=JS_UNDEFINED;}
    const char *text=NULL;
    if(!JS_IsUndefined(v)&&!JS_IsNull(v))text=JS_ToCString(ctx,v);
    if(!text && !strcmp(key,"message"))text=JS_ToCString(ctx,exc);
    JSValue out=JS_NewStringLen(ctx,text?text:fallback,text?strnlen(text,2048):strlen(fallback));
    if(text)JS_FreeCString(ctx,text);JS_FreeValue(ctx,v);return out;
}
static void emit_error_value(JSContext *ctx,JSValueConst exc,const char *kind) {
    JSValue o=JS_NewObject(ctx);
    JS_SetPropertyStr(ctx,o,"name",error_field(ctx,exc,"name","Error"));
    JS_SetPropertyStr(ctx,o,"message",error_field(ctx,exc,"message","unknown"));
    JS_SetPropertyStr(ctx,o,"stack",error_field(ctx,exc,"stack",""));
    JSValue json=JS_JSONStringify(ctx,o,JS_UNDEFINED,JS_UNDEFINED);JS_FreeValue(ctx,o);
    const char *text=JS_IsException(json)?NULL:JS_ToCString(ctx,json);
    if(text){outbox_push(kind,text);JS_FreeCString(ctx,text);}
    if(JS_IsException(json))JS_FreeValue(ctx,JS_GetException(ctx));
    JS_FreeValue(ctx,json);
}
static void emit_current_exception(JSContext *ctx) {
    JSValue exc=JS_GetException(ctx);emit_error_value(ctx,exc,"exception");JS_FreeValue(ctx,exc);
}
static void rejection_tracker(JSContext *ctx,JSValueConst promise,JSValueConst reason,JS_BOOL handled,void *opaque) {
    (void)opaque;
    for(int i=0;i<S.nrejections;i++)if(JS_VALUE_GET_PTR(S.rejections[i].promise)==JS_VALUE_GET_PTR(promise)){
        if(handled){JS_FreeValue(ctx,S.rejections[i].promise);JS_FreeValue(ctx,S.rejections[i].reason);S.rejections[i]=S.rejections[--S.nrejections];}
        return;
    }
    if(!handled && S.nrejections<64){
        S.rejections[S.nrejections].promise=JS_DupValue(ctx,promise);
        S.rejections[S.nrejections++].reason=JS_DupValue(ctx,reason);
    }
}

/* ---------------- module loader ---------------- */

/* 取 attributes 里的 type 字符串；缺省返回 NULL。
   import attributes 形如 { type: 'json' }（quickjs 解析器已支持该语法，
   把属性对象交给本 loader）。 */
static const char *attr_type(JSContext *ctx, JSValueConst attributes) {
    if (!JS_IsObject(attributes)) return NULL;
    JSValue v = JS_GetPropertyStr(ctx, attributes, "type");
    const char *s = NULL;
    if (JS_IsString(v)) s = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);
    return s;
}

/* 只认 { type: 'json' }，其余类型明确报错（浏览器对未支持类型抛错，
   页面可 try/catch —— 比"静默当 JS 解析"更接近真浏览器） */
static int module_check_attrs(JSContext *ctx, void *opaque,
                              JSValueConst attributes) {
    (void)opaque;
    if (!JS_IsObject(attributes)) return 0;
    JSValue has = JS_GetPropertyStr(ctx, attributes, "type");
    int known = 1;
    if (!JS_IsUndefined(has)) {
        JSValue v = JS_GetPropertyStr(ctx, attributes, "type");
        if (!JS_IsString(v)) {
            JS_FreeValue(ctx, v); JS_FreeValue(ctx, has);
            JS_ThrowTypeError(ctx, "module attribute values must be strings");
            return -1;
        }
        const char *s = JS_ToCString(ctx, v);
        if (s && strcmp(s, "json") != 0) {
            JS_ThrowTypeError(ctx, "unsupported module attribute type: %s", s);
            known = -1;
        }
        if (s) JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, v);
    }
    JS_FreeValue(ctx, has);
    return known < 0 ? -1 : 0;
}

static JSModuleDef *module_loader2(JSContext *ctx, const char *module_name,
                                   void *opaque, JSValueConst attributes) {
    (void)opaque;
    /* JSON 模块判定：attributes 明写 type:'json'，或宿主注册时标了 kind=json。
       两者任一成立即把源码包成 `export default <src>`。 */
    const char *atype = attr_type(ctx, attributes);
    int want_json = (atype && strcmp(atype, "json") == 0);
    if (atype) JS_FreeCString(ctx, atype);

    /* 编译缓存：同名 + 同 kind 只编译一次 */
    for (int i = 0; i < S.nmod; i++) {
        if (strcmp(S.modcache[i].url, module_name) == 0) {
            return S.modcache[i].m;
        }
    }
    const char *src = NULL;
    int kind = SRC_KIND_JS;
    for (int i = 0; i < S.nsrc; i++) {
        if (strcmp(S.sources[i].url, module_name) == 0) {
            src = S.sources[i].src;
            kind = S.sources[i].kind;
            break;
        }
    }
    if (!src) {
        JS_ThrowReferenceError(ctx,
            "module not prefetched (dynamic import of uncached URL): %s",
            module_name);
        return NULL;
    }
    if (want_json) kind = SRC_KIND_JSON;

    size_t source_len=strlen(src);
    if(S.scope_locked && (source_len>S.scope_max_source || source_len>S.scope_total_source-S.scope_compiled)) {
        JS_ThrowRangeError(ctx,"page module source budget exceeded: %s",module_name);return NULL;
    }
    if(S.scope_locked)S.scope_compiled+=(uint32_t)source_len;
    JSValue func_val;
    if (kind == SRC_KIND_JSON) {
        /* `export default ` + 原文；JSON 是合法的 JS 表达式字面量 */
        static const char pfx[] = "export default ";
        size_t sl = strlen(src);
        char *buf = malloc(sizeof(pfx) - 1 + sl + 1);
        if (!buf) { JS_ThrowOutOfMemory(ctx); return NULL; }
        memcpy(buf, pfx, sizeof(pfx) - 1);
        memcpy(buf + sizeof(pfx) - 1, src, sl);
        buf[sizeof(pfx) - 1 + sl] = 0;
        func_val = JS_Eval(ctx, buf, sizeof(pfx) - 1 + sl, module_name,
                           JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
        free(buf);
    } else {
        func_val = JS_Eval(ctx, src, strlen(src), module_name,
                           JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    }
    if (JS_IsException(func_val)) { emit_current_exception(ctx); return NULL; }
    /* import.meta.url = 模块名（恒为绝对 URL，含 ':'，免 realpath） */
    JSModuleDef *m = JS_VALUE_GET_PTR(func_val);
    JSValue meta = JS_GetImportMeta(ctx, m);
    if (!JS_IsException(meta)) {
        JS_SetPropertyStr(ctx, meta, "url", JS_NewString(ctx, module_name));
        JS_FreeValue(ctx, meta);
    }
    JS_FreeValue(ctx, func_val);
    if (S.nmod < MAX_MODCACHE) {
        S.modcache[S.nmod].url = strdup(module_name);
        S.modcache[S.nmod].m = m;
        S.nmod++;
    }
    return m;
}

/* 相对/根相对/裸说明符 → 绝对 URL。base 为绝对 http(s) URL。
   返回 js_malloc 内存（quickjs 侧 js_free）。 */
static char *normalize_module(JSContext *ctx, const char *base, const char *name, void *opaque) {
    (void)opaque;
    for (int i=0;i<S.nres;i++) {
        Resolution *r=&S.resolutions[i];
        if (!strcmp(r->base,base) && !strcmp(r->name,name)) return js_strdup(ctx,r->url);
    }
    size_t nl = strlen(name);
    /* 绝对 URL */
    if (strstr(name, "://")) {
        char *out = js_malloc(ctx, nl + 1);
        strcpy(out, name);
        return out;
    }
    /* npm:pkg → jsdelivr 单文件 ESM（remoteagent 语义） */
    if (nl > 4 && name[0] == 'n' && name[1] == 'p' && name[2] == 'm' && name[3] == ':') {
        const char *p = "https://cdn.jsdelivr.net/npm/";
        const char *sfx = "/+esm";
        size_t pl = strlen(p);
        char *out = js_malloc(ctx, pl + (nl - 4) + strlen(sfx) + 1);
        strcpy(out, p);
        memcpy(out + pl, name + 4, nl - 4);
        strcpy(out + pl + (nl - 4), sfx);
        return out;
    }
    /* base 取到目录：最后一个 '/' 为止 */
    size_t bl = strlen(base);
    size_t bl_dir = bl;
    for (size_t i = 0; i < bl; i++) if (base[i] == '/') bl_dir = i + 1;
    /* / 开头 → origin + name */
    if (name[0] == '/') {
        const char *rest = strstr(base, "://");
        size_t origin = rest ? (rest - base) + 3 : 0;
        while (origin < bl && base[origin] != '/') origin++;
        char *out = js_malloc(ctx, origin + nl + 1);
        memcpy(out, base, origin);
        memcpy(out + origin, name, nl + 1);
        return out;
    }
    /* 相对路径：拼段后消解 . / .. */
    char *joined = js_malloc(ctx, bl_dir + nl + 1);
    memcpy(joined, base, bl_dir);
    memcpy(joined + bl_dir, name, nl + 1);
    size_t jl = bl_dir + nl;
    /* 消解：跳过 "./"，"../" 弹一段 */
    char *out = js_malloc(ctx, jl + 2);
    size_t o = 0, i = 0;
    /* 协议头原样保留（"//" 不可当相对段） */
    const char *prot = strstr(joined, "://");
    size_t skip = prot ? (prot - joined) + 3 : 0;
    memcpy(out, joined, skip);
    o = skip; i = skip;
    size_t seg_start = o;
    while (i <= jl) {
        char c = joined[i];
        if (c == '/' || c == 0) {
            size_t seglen = i - seg_start;
            if (seglen == 1 && joined[seg_start] == '.') {
                /* skip ./ */
            } else if (seglen == 2 && joined[seg_start] == '.' && joined[seg_start + 1] == '.') {
                if (o > skip + 1) {
                    o--;                       /* 弹掉尾 '/' */
                    while (o > skip && out[o - 1] != '/') o--;
                }
            } else if (seglen > 0) {
                memcpy(out + o, joined + seg_start, seglen);
                o += seglen;
                if (c == '/') out[o++] = '/';
            } else if (c == '/' && o > skip && out[o - 1] != '/') {
                out[o++] = '/';
            }
            seg_start = i + 1;
        }
        i++;
    }
    while (o > skip + 1 && out[o - 1] == '/') o--;   /* 去尾斜杠（保留协议头 //） */
    out[o] = 0;
    js_free(ctx, joined);
    return out;
}

/* ---------------- C ABI 导出 ---------------- */

__attribute__((export_name("qjs_new")))
uint32_t qjs_new(void) {
    memset(&S, 0, sizeof(S));
    S.rt = JS_NewRuntime();
    if (!S.rt) return 0;
    JS_SetMemoryLimit(S.rt, 128ull * 1024 * 1024);
    JS_SetMaxStackSize(S.rt, 512 * 1024);
    S.interrupt_budget = 100000000;   /* 兜底；qjs_set_limits 可调 */
    JS_SetInterruptHandler(S.rt, NULL, NULL);
    /* Func2 版 loader：拿到 import attributes（{ type:'json' }）→ JSON modules */
    JS_SetModuleLoaderFunc2(S.rt, normalize_module, module_loader2,
                            module_check_attrs, NULL);
    S.ctx = JS_NewContext(S.rt);
    if (!S.ctx) { JS_FreeRuntime(S.rt); S.rt = NULL; return 0; }
    /* Intl / Temporal：quickjs 的 JS_NewContext 不装这两个内建，必须宿主显式挂。
       缺失的代价很大——Intl.NumberFormat / DateTimeFormat / RelativeTimeFormat /
       PluralRules 几乎每个现代站点和打包产物都会碰，缺了直接抛 ReferenceError。
       需构建期 -DCONFIG_TEMPORAL_INTL（见 build.sh）。 */
    if (JS_AddIntrinsicIntl(S.ctx) < 0 ||
        JS_AddIntrinsicTemporal(S.ctx) < 0) {
        JS_FreeContext(S.ctx); JS_FreeRuntime(S.rt);
        S.ctx = NULL; S.rt = NULL; return 0;
    }
    JS_SetHostPromiseRejectionTracker(S.rt,rejection_tracker,NULL);
    /* JS→宿主唯一出口 */
    JSValue global = JS_GetGlobalObject(S.ctx);
    JS_SetPropertyStr(S.ctx, global, "__hostLayout", JS_NewCFunction(S.ctx, js_layout, "__hostLayout", 1));
    JS_SetPropertyStr(S.ctx, global, "__hostEnqueue",
                      JS_NewCFunction(S.ctx, js_enqueue, "__hostEnqueue", 2));
    JS_FreeValue(S.ctx, global);
    return 1;
}

/* 限额：mem 字节 / 栈字节 / 单次脚本的中断预算（调用计数） */
__attribute__((export_name("qjs_set_limits")))
void qjs_set_limits(uint32_t mem, uint32_t stack, uint32_t budget) {
    if (S.rt) {
        JS_SetMemoryLimit(S.rt, mem);
        JS_SetMaxStackSize(S.rt, stack);
    }
    S.interrupt_budget = budget;
}

__attribute__((export_name("qjs_interrupt_reset")))
void qjs_interrupt_reset(void) { if(!S.scope_locked) S.interrupt_count = 0; }

static int interrupt_handler(JSRuntime *rt, void *opaque) {
    (void)rt; (void)opaque;
    return ++S.interrupt_count > S.interrupt_budget;
}

__attribute__((export_name("qjs_set_interrupt")))
void qjs_set_interrupt(uint32_t enabled, uint32_t budget) {
    if (!S.rt) return;
    S.interrupt_budget = budget;
    JS_SetInterruptHandler(S.rt, enabled ? interrupt_handler : NULL, NULL);
}

/* A page shares one instruction budget across classic scripts and microtasks.
   Source caps are checked before module compilation, which a JS timer cannot preempt. */
__attribute__((export_name("qjs_scope_begin")))
void qjs_scope_begin(uint32_t budget,uint32_t per_source,uint32_t total_source) {
    S.saved_interrupt_budget=S.interrupt_budget;S.interrupt_budget=budget;
    S.interrupt_count=0;S.scope_locked=1;S.scope_max_source=per_source;
    S.scope_total_source=total_source;S.scope_compiled=0;
}
__attribute__((export_name("qjs_scope_end")))
void qjs_scope_end(void) {
    if(S.scope_locked)S.interrupt_budget=S.saved_interrupt_budget;
    S.scope_locked=0;S.interrupt_count=0;
}
__attribute__((export_name("qjs_scope_exhausted")))
uint32_t qjs_scope_exhausted(void) {return S.scope_locked && S.interrupt_count>S.interrupt_budget;}

/* [u32 base length][u32 name length][base][name][absolute resolution].
   The host WHATWG/import-map resolver registers exact aliases, avoiding two
   subtly different module-resolution algorithms across the Wasm boundary. */
__attribute__((export_name("qjs_add_module_resolution")))
uint32_t qjs_add_module_resolution(uint32_t len) {
    if(len<8||!S.input||S.nres>=4096)return 0;
    uint32_t bl,nl;memcpy(&bl,S.input,4);memcpy(&nl,S.input+4,4);
    if((size_t)bl+nl+8>=len)return 0;
    char *base=strndup((char*)S.input+8,bl),*name=strndup((char*)S.input+8+bl,nl);
    char *url=strndup((char*)S.input+8+bl+nl,len-8-bl-nl);
    if(!base||!name||!url){free(base);free(name);free(url);return 0;}
    for(int i=0;i<S.nres;i++)if(!strcmp(S.resolutions[i].base,base)&&!strcmp(S.resolutions[i].name,name)){
        free(S.resolutions[i].url);S.resolutions[i].url=url;free(base);free(name);return 1;
    }
    S.resolutions[S.nres++]=(Resolution){base,name,url};return 1;
}

/* 中断计数器需要 rt 存在后生效：qjs_new 里先 NULL，qjs_enable_interrupt 后开 */
__attribute__((export_name("qjs_enable_interrupt")))
void qjs_enable_interrupt(void) {
    if (S.rt) JS_SetInterruptHandler(S.rt, interrupt_handler, NULL);
}

__attribute__((export_name("qjs_alloc")))
uint32_t qjs_alloc(uint32_t len) {
    /* 容量复用：页面管线里最大载荷是整页 HTML（可达数 MB），每次都
       free+malloc 会把 wasi 分配器打进 mmap/munmap。大块按 64KB 对齐增长，
       只在不够时重新分配。 */
    if (len + 1 > S.input_cap) {
        size_t cap = S.input_cap ? S.input_cap : 65536;
        while (cap < (size_t)len + 1) cap *= 2;
        unsigned char *nb = realloc(S.input, cap);
        if (!nb) return 0;
        S.input = nb;
        S.input_cap = cap;
    }
    S.input_len = len;
    return (uint32_t)(uintptr_t)S.input;
}

/* 输入 UTF-8 合法性：JS 侧 TextEncoder 保证。
   缓冲布局：[name][code]；name 复制到栈缓冲后终结，不覆盖 code 首字节。 */
__attribute__((export_name("qjs_eval")))
uint32_t qjs_eval(uint32_t len, uint32_t is_module,
                  uint32_t name_len) {
    if (!S.ctx) return 1;
    S.input[len] = 0;
    char namebuf[512];
    const char *name;
    if (name_len == 0) {
        name = "<eval>";
    } else {
        if (name_len > sizeof(namebuf) - 1) name_len = sizeof(namebuf) - 1;
        memcpy(namebuf, S.input, name_len);
        namebuf[name_len] = 0;
        name = namebuf;
    }
    const char *code = (const char *)S.input + name_len;
    size_t code_len = (size_t)len - name_len;
    if(!S.scope_locked) S.interrupt_count = 0;
    uint32_t flags = is_module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL;
    JSValue v = JS_Eval(S.ctx, code, code_len, name, flags);
    if (JS_IsException(v)) {
        emit_current_exception(S.ctx);
        return 1;
    }
    JS_FreeValue(S.ctx, v);
    return 0;
}

/* 预取模块源码表：[urlLen(u32)][url][src] 布局写在 qjs_alloc 缓冲 */
/* 缓冲布局 [urlLen(u32)][kind(u8)][url][src]；url/src 均按显式长度拷贝，
   不依赖 NUL（曾因在 4+ul 处写终结符覆盖 src 首字节导致 srclen=0）。
   kind：0=JS（走模块编译），1=JSON（包成 `export default <src>`）。
   注意：同 URL 重新注册只在"该 URL 还没被 import 过"时生效 —— 一旦 import，
   模块由 quickjs 自己的模块注册表按 URL 唯一持有，quickjs 未暴露模块失效
   API（无 JS_FreeModule 之类），换新源码也换不掉已求值的模块。这是已知边界。 */
__attribute__((export_name("qjs_add_module_source")))
uint32_t qjs_add_module_source(uint32_t len) {
    if (S.nsrc >= MAX_SOURCES || len < 5 || !S.input) return 0;
    uint32_t ul;
    memcpy(&ul, S.input, 4);
    if (4 + 1 + (size_t)ul > len) return 0;
    int kind = S.input[4];
    size_t slen = (size_t)len - 5 - ul;
    char *url = malloc(ul + 1);
    char *src = malloc(slen + 1);
    if (!url || !src) { free(url); free(src); return 0; }
    memcpy(url, S.input + 5, ul); url[ul] = 0;
    memcpy(src, S.input + 5 + ul, slen); src[slen] = 0;
    for (int i = 0; i < S.nsrc; i++) {
        if (strcmp(S.sources[i].url, url) == 0) {
            free(S.sources[i].src);
            S.sources[i].src = src;
            S.sources[i].kind = kind;
            free(url);
            return 1;
        }
    }
    S.sources[S.nsrc].url = url;
    S.sources[S.nsrc].src = src;
    S.sources[S.nsrc].kind = kind;
    S.nsrc++;
    return 1;
}

/* 调用全局函数：input = [nameLen(u32)][name][argsJson]；返回 packed JSON
   {"ok":true,"value":...,"undef":bool} | {"ok":false,"error":{message,stack}} */
__attribute__((export_name("qjs_call_global")))
uint64_t qjs_call_global(uint32_t len) {
    if (!S.ctx) return pack_str("{\"ok\":false,\"error\":{\"message\":\"no ctx\"}}");
    uint32_t nl;
    memcpy(&nl, S.input, 4);
    if (4 + (size_t)nl > len) return pack_str("{\"ok\":false,\"error\":{\"message\":\"bad len\"}}");
    /* name 显式拷贝终结；args 按显式长度解析（NUL 终结符曾覆盖 args 首字节） */
    char namebuf[128];
    if (nl > sizeof(namebuf) - 1) nl = sizeof(namebuf) - 1;
    memcpy(namebuf, S.input + 4, nl);
    namebuf[nl] = 0;
    const char *name = namebuf;
    size_t alen = (size_t)len - 4 - nl;
    const char *args_json = (const char *)S.input + 4 + nl;

    JSValue global = JS_GetGlobalObject(S.ctx);
    JSValue fn = JS_GetPropertyStr(S.ctx, global, name);
    JS_FreeValue(S.ctx, global);
    if (JS_IsException(fn) || !JS_IsFunction(S.ctx, fn)) {
        emit_current_exception(S.ctx);
        JS_FreeValue(S.ctx, fn);
        return pack_str("{\"ok\":false,\"error\":{\"message\":\"not a function\"}}");
    }
    /* args 以原始字符串直通（不再 C 侧 ParseJSON）：对象载荷由 VM 内
       __dispatch 的 JSON.parse 负责，'eval' 这类字符串参数天然正确。 */
    if(!S.scope_locked) S.interrupt_count = 0;
    JSValue arg = alen > 0 ? JS_NewStringLen(S.ctx, args_json, alen) : JS_UNDEFINED;
    JSValue ret = JS_Call(S.ctx, fn, JS_UNDEFINED, 1, &arg);
    JS_FreeValue(S.ctx, arg);
    JS_FreeValue(S.ctx, fn);
    if (JS_IsException(ret)) {
        emit_current_exception(S.ctx);
        return pack_str("{\"ok\":false,\"error\":{\"message\":\"threw\"}}");
    }
    int undef = JS_IsUndefined(ret);
    JSValue j = JS_JSONStringify(S.ctx, ret, JS_UNDEFINED, JS_UNDEFINED);
    JS_FreeValue(S.ctx, ret);
    if (JS_IsException(j) || JS_IsUndefined(j)) {
        JSValue exc = JS_GetException(S.ctx);   /* stringify 失败：吞掉，值置 null */
        JS_FreeValue(S.ctx, exc);
        return pack_str(undef ? "{\"ok\":true,\"value\":null,\"undef\":true}"
                              : "{\"ok\":true,\"value\":null}");
    }
    size_t jl; const char *js = JS_ToCStringLen(S.ctx, &jl, j);
    size_t cap = jl + 48;
    char *buf = malloc(cap);
    snprintf(buf, cap, "{\"ok\":true,\"value\":%s%s}", js ? js : "null", undef ? ",\"undef\":true" : "");
    uint64_t out = pack_out(buf, strlen(buf));
    free(buf);
    if (js) JS_FreeCString(S.ctx, js);
    JS_FreeValue(S.ctx, j);
    return out;
}

/* 微任务泵：1=执行了一个，0=队列空，2=job 内异常（已入 outbox） */
__attribute__((export_name("qjs_exec_job")))
uint32_t qjs_exec_job(void) {
    if (!S.rt) return 0;
    JSContext *ctx1;
    int r = JS_ExecutePendingJob(S.rt, &ctx1);
    if (r < 0) { emit_current_exception(S.ctx); return 2; }
    return r > 0 ? 1 : 0;
}

__attribute__((export_name("qjs_job_pending")))
uint32_t qjs_job_pending(void) {
    return S.rt && JS_IsJobPending(S.rt);
}

/* 取走 outbox 全部任务：packed JSON 数组。
   若期间发生过溢出丢弃，数组末尾补一条 outbox_dropped 任务——
   静默截断日志会让人误判页面行为，必须让宿主看得见。 */
__attribute__((export_name("qjs_take_tasks")))
uint64_t qjs_take_tasks(void) {
    /* Observe after a microtask checkpoint, allowing an immediate catch handler
       to remove a rejection before it is reported as unhandled. */
    for(int i=0;i<S.nrejections;i++){
        emit_error_value(S.ctx,S.rejections[i].reason,"unhandled_rejection");
        JS_FreeValue(S.ctx,S.rejections[i].promise);JS_FreeValue(S.ctx,S.rejections[i].reason);
    }
    S.nrejections=0;
    unsigned long dropped = S.outbox_dropped;
    S.outbox_dropped = 0;
    if (S.nout == 0) {
        if (!dropped) return pack_str("[]");
        char tmp[96];
        int n = snprintf(tmp, sizeof(tmp),
                         "[{\"kind\":\"outbox_dropped\",\"payload\":{\"n\":%lu}}]", dropped);
        return pack_out(tmp, n);
    }
    char dbuf[96];
    size_t dlen = 0;
    if (dropped) {
        dlen = (size_t)snprintf(dbuf, sizeof(dbuf),
            ",{\"kind\":\"outbox_dropped\",\"payload\":{\"n\":%lu}}", dropped);
    }
    size_t cap = 2;
    for (int i = 0; i < S.nout; i++) cap += strlen(S.outbox[i]) + 2;
    cap += dlen + 1;
    char *buf = malloc(cap + 1);
    size_t o = 0;
    buf[o++] = '[';
    for (int i = 0; i < S.nout; i++) {
        if (i) buf[o++] = ',';
        size_t l = strlen(S.outbox[i]);
        memcpy(buf + o, S.outbox[i], l);
        o += l;
        free(S.outbox[i]);
        S.outbox[i] = NULL;
    }
    if (dlen) { memcpy(buf + o, dbuf, dlen); o += dlen; }
    buf[o++] = ']';
    S.nout = 0;
    uint64_t out = pack_out(buf, o);
    free(buf);
    return out;
}

/* 显式回收：换页后旧 DOM（可达数 MB）整批变垃圾，让 GC 立刻收掉，
   否则连续导航的 parse 耗时会随迭代次数劣化（实测 193KB 页 364ms→469ms/12 次）。 */
__attribute__((export_name("qjs_run_gc")))
void qjs_run_gc(void) {
    if (S.rt) JS_RunGC(S.rt);
}

__attribute__((export_name("qjs_free")))
void qjs_free(void) {
    if(S.rt)JS_SetHostPromiseRejectionTracker(S.rt,NULL,NULL);
    for(int i=0;i<S.nrejections;i++){JS_FreeValue(S.ctx,S.rejections[i].promise);JS_FreeValue(S.ctx,S.rejections[i].reason);}
    S.nrejections=0;
    if (S.ctx) { JS_FreeContext(S.ctx); S.ctx = NULL; }
    if (S.rt) { JS_FreeRuntime(S.rt); S.rt = NULL; }
    for (int i = 0; i < S.nsrc; i++) { free(S.sources[i].url); free(S.sources[i].src); }
    S.nsrc = 0;
    for (int i = 0; i < S.nmod; i++) free(S.modcache[i].url);
    S.nmod = 0;
    for(int i=0;i<S.nres;i++){free(S.resolutions[i].base);free(S.resolutions[i].name);free(S.resolutions[i].url);}
    S.nres=0;
    for (int i = 0; i < S.nout; i++) free(S.outbox[i]);
    S.nout = 0;
    S.outbox_dropped = 0;
    free(S.input); S.input = NULL; S.input_cap = 0;
    free(S.out_buf); S.out_buf = NULL; S.out_cap = 0;
}
