"""Apply the narrow float integration fix to the pinned Blitz checkout."""
from pathlib import Path

root = Path(__file__).resolve().parents[1] / '.cache/blitz/packages/blitz-dom/src/layout'
p = root / 'construct.rs'
s = p.read_text()
s = s.replace('} else if float.is_floating() {', '} else if cfg!(feature = "floats") && float.is_floating() {')
p.write_text(s)

p = root / 'inline.rs'
s = p.read_text()
marker = '            let mut breaker = inline_layout.layout.break_lines();'
if 'quickjsbrowser: bound layout yields' not in s:
    assert s.count(marker) == 1, 'Pinned inline layout source changed'
    s = s.replace(marker, '''            // quickjsbrowser: bound layout yields so a future integration error
            // fails explicitly instead of exhausting a Worker's CPU allocation.
            let mut yield_budget = inline_layout.text.len()
                .saturating_add(inline_layout.layout.inline_boxes().len())
                .saturating_mul(4)
                .saturating_add(1024);
''' + marker)
    loop = '            while let Some(yield_data) = breaker.break_next() {'
    assert s.count(loop) == 1, 'Pinned line-break loop changed'
    s = s.replace(loop, loop + '''
                assert!(yield_budget > 0, "inline layout exceeded its progress budget");
                yield_budget -= 1;''')
p.write_text(s)
