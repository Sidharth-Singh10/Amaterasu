import { describe, expect, it } from "vitest"

import { renderMarkdown } from "./markdown"

describe("renderMarkdown", () => {
  it("renders the markdown the chart agent emits", () => {
    const html = renderMarkdown("## Resistance\n\nThe **₹1,744** high held.\n\n- first\n- second")
    expect(html).toContain("<h2>Resistance</h2>")
    expect(html).toContain("<strong>₹1,744</strong>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>first</li>")
  })

  it("renders GFM tables", () => {
    const html = renderMarkdown("| Level | Why |\n|---|---|\n| ₹1,744 | Record high |")
    expect(html).toContain("<table>")
    expect(html).toContain("<th>Level</th>")
    expect(html).toContain("<td>₹1,744</td>")
  })

  it("escapes raw HTML instead of rendering it", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;script&gt;")
  })

  it("defuses javascript: links", () => {
    const html = renderMarkdown("[click](javascript:alert(1))")
    expect(html).not.toContain("<a ")
    expect(html).toContain("[click](javascript:alert(1))")
  })

  it("opens links in a new tab", () => {
    const html = renderMarkdown("[open the saved analysis](https://www.indmoney.com/widget/page)")
    expect(html).toContain('href="https://www.indmoney.com/widget/page"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it("keeps single newlines as line breaks", () => {
    expect(renderMarkdown("line one\nline two")).toContain("<br>")
  })

  it("renders images as alt text instead of loading them", () => {
    const html = renderMarkdown("![RELIANCE chart](https://tracker.example/pixel.png)")
    expect(html).not.toContain("<img")
    expect(html).toContain("[image: RELIANCE chart]")
  })

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("")
  })
})
