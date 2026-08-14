/** Viewport rect of the caret (or a given offset) inside a textarea. */
export function getTextareaCaretRect(
  ta: HTMLTextAreaElement,
  offset = ta.selectionStart,
): { top: number; left: number; height: number } {
  const style = window.getComputedStyle(ta)
  const mirror = document.createElement('div')
  const props = [
    'boxSizing',
    'width',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'lineHeight',
    'fontFamily',
    'textAlign',
    'textTransform',
    'textIndent',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
    'whiteSpace',
    'wordBreak',
    'overflowWrap',
  ] as const
  for (const prop of props) {
    mirror.style[prop] = style[prop]
  }
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.height = 'auto'
  mirror.style.overflow = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.width = `${ta.clientWidth}px`

  const before = ta.value.slice(0, offset)
  mirror.textContent = before
  const marker = document.createElement('span')
  marker.textContent = ta.value.slice(offset, offset + 1) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const taRect = ta.getBoundingClientRect()
  const borderTop = parseFloat(style.borderTopWidth) || 0
  const borderLeft = parseFloat(style.borderLeftWidth) || 0
  const lineH =
    parseFloat(style.lineHeight) || marker.offsetHeight || ta.scrollHeight
  const top =
    taRect.top + borderTop + marker.offsetTop - ta.scrollTop
  const left =
    taRect.left + borderLeft + marker.offsetLeft - ta.scrollLeft

  document.body.removeChild(mirror)
  return { top, left, height: lineH }
}
