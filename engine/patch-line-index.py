"""Bound QuickJS pc-to-source lookup work while preserving original positions."""
from pathlib import Path
path=Path(__file__).resolve().parents[1]/'vendor/quickjs/quickjs.c'
s=path.read_text()
if 'QJSB_SOURCE_INDEX' in s:raise SystemExit(0)
old='    const uint8_t *buf_start;\n} GetLineColCache;'
new='''    const uint8_t *buf_start;
    /* QJSB_SOURCE_INDEX: at most 1025 checkpoints (~8 KiB per parser),
       lazily filled in source order. Nested function compilation may request
       positions backwards across a megabyte minified line. */
    size_t index_stride, index_count;
    const uint8_t *index_ptr;
    int index_line, index_col;
    struct { int line, col; } index[1025];
} GetLineColCache;'''
assert old in s;s=s.replace(old,new,1)
a=s.index('static int get_line_col_cached(');b=s.index("\n/* 'ptr' is the position",a)
s=s[:a]+'''static int get_line_col_cached(GetLineColCache *s, int *pcol_num, const uint8_t *ptr)
{
    size_t offset = ptr - s->buf_start;
    size_t bucket = offset / s->index_stride;
    int lines, col;
    const uint8_t *anchor;
    while (s->index_count <= bucket) {
        anchor = s->buf_start + s->index_count * s->index_stride;
        lines = get_line_col(&col, s->index_ptr, anchor - s->index_ptr);
        s->index_line += lines;
        s->index_col = lines ? col : s->index_col + col;
        s->index[s->index_count].line = s->index_line;
        s->index[s->index_count].col = s->index_col;
        s->index_ptr = anchor;
        s->index_count++;
    }
    anchor = s->buf_start + bucket * s->index_stride;
    /* Retain the original fast path for nearby, forward positions. */
    if (ptr >= s->ptr && s->ptr >= anchor) {
        lines = get_line_col(&col, s->ptr, ptr - s->ptr);
        s->line_num += lines;
        s->col_num = lines ? col : s->col_num + col;
    } else {
        lines = get_line_col(&col, anchor, ptr - anchor);
        s->line_num = s->index[bucket].line + lines;
        s->col_num = lines ? col : s->index[bucket].col + col;
    }
    s->ptr = ptr;
    *pcol_num = s->col_num;
    return s->line_num;
}
''' +s[b:]
old='    s->get_line_col_cache.col_num = 0;'
new='''    s->get_line_col_cache.col_num = 0;
    /* Round up to 256 bytes, keeping the final inclusive position in range. */
    s->get_line_col_cache.index_stride = (((input_len + 1023) / 1024 + 255) / 256) * 256;
    if (!s->get_line_col_cache.index_stride) s->get_line_col_cache.index_stride = 256;
    s->get_line_col_cache.index_count = 1;
    s->get_line_col_cache.index_ptr = s->buf_start;'''
assert old in s;s=s.replace(old,new,1);path.write_text(s)
