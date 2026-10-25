const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

// ── current year ─────────────────────────────────────────────────────────
const year = document.querySelector("#year")
if (year) year.textContent = String(new Date().getFullYear())

// ── mobile navigation ────────────────────────────────────────────────────
const nav = document.querySelector("#nav")
const navToggle = document.querySelector(".nav-toggle")

if (nav && navToggle) {
  const close = () => {
    nav.classList.remove("is-open")
    navToggle.setAttribute("aria-expanded", "false")
  }

  navToggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open")
    navToggle.setAttribute("aria-expanded", String(open))
  })

  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) close()
  })

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close()
  })
}

// ── copy buttons ─────────────────────────────────────────────────────────
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.append(area)
  area.select()
  document.execCommand("copy")
  area.remove()
}

for (const block of document.querySelectorAll("[data-copy]")) {
  const button = block.querySelector(".copy")
  const code = block.querySelector("code")
  if (!button || !code) continue

  button.addEventListener("click", async () => {
    const previous = button.textContent
    try {
      await copyText(code.textContent.trim())
      button.textContent = "Copied"
      window.setTimeout(() => {
        button.textContent = previous
      }, 1600)
    } catch {
      button.textContent = "Select"
      const range = document.createRange()
      range.selectNodeContents(code)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  })
}

// ── lazy demo ────────────────────────────────────────────────────────────
const demoFrame = document.querySelector("#demo-frame")
const demoLaunch = document.querySelector("#demo-launch")

if (demoFrame && demoLaunch) {
  demoLaunch.addEventListener("click", () => {
    const iframe = document.createElement("iframe")
    iframe.src = "./demo/?demo=1"
    iframe.title = "Amaterasu interactive chart demo"
    iframe.loading = "eager"
    iframe.setAttribute(
      "allow",
      "clipboard-read; clipboard-write; fullscreen",
    )
    demoFrame.replaceChildren(iframe)
    iframe.focus()
  })
}

// ── reveal on scroll ─────────────────────────────────────────────────────
if (!reduceMotion && "IntersectionObserver" in window) {
  const targets = document.querySelectorAll(
    ".section-head, .card, .step, .code-panel, .demo-frame, .adapter, .fixture-list, .target, .install-card, .callout, .faq details, .closing h2, .closing-actions",
  )

  document.body.classList.add("reveal-ready")
  for (const target of targets) target.setAttribute("data-reveal", "")

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible")
          observer.unobserve(entry.target)
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  )

  for (const target of targets) observer.observe(target)
}
