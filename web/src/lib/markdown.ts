import MarkdownIt from "markdown-it"

/**
 * Markdown rendering for the agent chat panel.
 *
 * `html: false` (the default) means raw HTML in model output is escaped, and
 * markdown-it's built-in `validateLink` refuses `javascript:`, `vbscript:`,
 * `file:` and `data:` URLs — so the rendered string is safe for `{@html}`.
 */
const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true,
})

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank")
  tokens[idx].attrSet("rel", "noopener noreferrer")
  return defaultLinkOpen(tokens, idx, options, env, self)
}

// Images would fetch remote content into the panel; render alt text instead.
md.renderer.rules.image = (tokens, idx) => {
  const alt = tokens[idx].content || tokens[idx].attrGet("alt") || ""
  return md.utils.escapeHtml(alt ? `[image: ${alt}]` : "[image]")
}

export function renderMarkdown(text: string): string {
  return md.render(text)
}
