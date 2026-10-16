"""Use WASI libc's real allocation sizes for QuickJS GC and memory limits."""
from pathlib import Path
path=Path(__file__).resolve().parents[1]/'vendor/quickjs/quickjs.c'
s=path.read_text()
if 'QJSB_WASI_ALLOCATION_SIZE' in s:raise SystemExit(0)
a=s.index('static size_t js_def_malloc_usable_size');b=s.index('static void *js_def_malloc',a)
fragment=s[a:b];old='#elif defined(__EMSCRIPTEN__)\n    return 0;';new='''#elif defined(__wasi__)
    /* QJSB_WASI_ALLOCATION_SIZE: the Emscripten stub otherwise counts
       only allocator headers, suppressing GC and defeating memory limits. */
    return malloc_usable_size((void *)ptr);
#elif defined(__EMSCRIPTEN__)
    return 0;'''
assert old in fragment;fragment=fragment.replace(old,new,1)
s=s[:a]+fragment+s[b:]
# Include the WASI allocation-size declaration even with __EMSCRIPTEN__ set.
s=s.replace('#include <stdlib.h>','#include <stdlib.h>\n#ifdef __wasi__\n#include <malloc.h>\n#endif',1)
path.write_text(s)
