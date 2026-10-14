// Lists while typing, in every message box (main, thread, DM PiP, edit).
// Start a line with "- " (or "* ", "+ ") or "1. " and it is a list item:
//   Shift+Enter   the next item, numbered on from the last one
//   Shift+Enter on an empty item   ends the list
//   Tab / Shift+Tab   one level deeper / shallower (two spaces a level,
//                     which is how the message renderer reads nesting)
// Outside a list item none of these keys do anything new. Edits go through
// insertText where the browser has it, so Ctrl+Z still undoes them.

const ITEM_RE = /^([ \t]*)([-*+]|\d+\.)([ \t]+)(.*)$/;

// Replaces text in the box the way typing would.
function replaceRange(ta, start, end, text) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let done = false;
  try { done = document.execCommand('insertText', false, text); } catch { done = false; } // older engines: fall back below
  if (!done) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function lineAround(ta) {
  const value = ta.value;
  const caret = ta.selectionStart;
  const start = value.lastIndexOf('\n', caret - 1) + 1;
  let end = value.indexOf('\n', caret);
  if (end === -1) end = value.length;
  return { value, caret, start, end, text: value.slice(start, end) };
}

// The number the next ordered item at this indent gets: one more than the
// closest earlier item at the same indent, or 1.
function nextNumber(value, lineStart, indent) {
  const before = value.slice(0, lineStart).split('\n');
  for (let i = before.length - 1; i >= 0; i--) {
    const m = before[i].match(ITEM_RE);
    if (!m) { if (before[i].trim() === '') continue; break; }
    if (m[1].length < indent.length) break;
    if (m[1] === indent && /^\d+\.$/.test(m[2])) return parseInt(m[2], 10) + 1;
  }
  return 1;
}

export default {

// Returns true when it handled the key (the caller then stops).
_composerListKey(e, ta) {
  if (!ta || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (ta.selectionStart !== ta.selectionEnd) return false;
  const isShiftEnter = e.key === 'Enter' && e.shiftKey;
  const isTab = e.key === 'Tab';
  if (!isShiftEnter && !isTab) return false;

  const line = lineAround(ta);
  const m = line.text.match(ITEM_RE);
  if (!m) return false;
  const [, indent, marker, gap, body] = m;
  const ordered = /^\d+\.$/.test(marker);

  if (isShiftEnter) {
    e.preventDefault();
    // An empty item ends the list: its marker goes, the line stays.
    if (!body.trim() && line.caret >= line.start + indent.length + marker.length) {
      replaceRange(ta, line.start, line.end, '');
      return true;
    }
    const next = ordered ? `${parseInt(marker, 10) + 1}.` : marker;
    replaceRange(ta, line.caret, line.caret, `\n${indent}${next}${gap}`);
    return true;
  }

  // Tab / Shift+Tab: one level deeper or shallower.
  e.preventDefault();
  const caretInBody = line.caret - line.start;
  if (!e.shiftKey) {
    const newIndent = indent + '  ';
    const newMarker = ordered ? '1.' : marker;
    const newLine = `${newIndent}${newMarker}${gap}${body}`;
    replaceRange(ta, line.start, line.end, newLine);
    const pos = line.start + Math.max(newIndent.length + newMarker.length + gap.length, caretInBody + (newLine.length - line.text.length));
    ta.setSelectionRange(pos, pos);
    return true;
  }
  if (!indent) return true; // already at the top level; Shift+Tab stays put
  const newIndent = indent.replace(/\t$/, '').replace(/ {1,2}$/, '');
  const newMarker = ordered ? `${nextNumber(line.value, line.start, newIndent)}.` : marker;
  const newLine = `${newIndent}${newMarker}${gap}${body}`;
  replaceRange(ta, line.start, line.end, newLine);
  const pos = line.start + Math.max(newIndent.length + newMarker.length + gap.length, caretInBody + (newLine.length - line.text.length));
  ta.setSelectionRange(pos, pos);
  return true;
},

};
