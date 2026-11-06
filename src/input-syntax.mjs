// Parse composer-only syntax; leave request routing and selector validation to parseRequest.
export function parseInput(text) {
  if (typeof text !== 'string') return null;
  if (text.includes('<&') || text.includes('</&')) {
    const open = text.indexOf('<&');
    const head = /^<&\s+([^<>]*)>/.exec(text.slice(open));
    if (open < 0 || !head) throw new Error('Malformed <&> delimiter');
    const close = text.indexOf('</&>', open + head[0].length);
    if (close < 0 || text.slice(0, open).includes('</&>') ||
        text.slice(open + head[0].length, close).includes('<&') ||
        text.slice(close + 4).includes('<&') || text.slice(close + 4).includes('</&>'))
      throw new Error('Malformed or multiple <&> delimiters');
    const attrs = {};
    let rest = head[1];
    while (rest.trim()) {
      const attr = /^\s*(type|model)=("[^"]*"|[a-z]+)(?=\s|$)/.exec(rest);
      if (!attr || Object.hasOwn(attrs, attr[1])) throw new Error('Invalid or duplicate <&> attribute');
      attrs[attr[1]] = attr[2];
      rest = rest.slice(attr[0].length);
    }
    if (!['bg', 'agent', 'swarm', 'council', 'todo'].includes(attrs.type) ||
        (attrs.model !== undefined && (!/^"[^"]+"$/.test(attrs.model) || !attrs.model.slice(1, -1).trim())))
      throw new Error('Invalid <&> type or model attribute');
    const body = text.slice(open + head[0].length, close);
    if (!body.trim()) throw new Error('Empty <&> task');
    const foreground = text.slice(0, open) + text.slice(close + 4);
    if (/^\s*(?:&|\|\||~&&|~\|\|)/.test(foreground) || /\s+&\s*(?:\n|$)/.test(foreground))
      throw new Error('Only one background form is allowed per input');
    return {
      alias: '&', args: `${attrs.type === 'agent' ? 'bg' : attrs.type} ${body}`,
      ...(attrs.model ? { model: attrs.model.slice(1, -1) } : {}),
      foreground: foreground.trim() ? foreground : '',
    };
  }
  const leading = /^[ \t]*(~&&|~\|\||&&|\|\||&)[ \t]*([\s\S]*)$/.exec(text);
  if (leading) {
    if (/^\n\S/.test(leading[2])) throw new Error('Ambiguous empty leading background line');
    return { alias: leading[1], args: leading[2], foreground: '' };
  }
  const lines = text.split('\n');
  const trailing = lines.flatMap((line, index) => {
    const match = /^(.*?)\s+&[ \t]*$/.exec(line);
    return match && match[1].trim() && !/^\s*(?:&|\|\||~&&|~\|\|)/.test(match[1]) ? [{ index, prompt: match[1] }] : [];
  });
  if (trailing.length > 1) throw new Error('Only one trailing & background line is allowed');
  if (trailing.length === 0) return null;
  const [{ index, prompt }] = trailing;
  lines.splice(index, 1);
  const foreground = lines.join('\n');
  return { alias: '&', args: prompt, foreground: foreground.trim() ? foreground : '' };
}
