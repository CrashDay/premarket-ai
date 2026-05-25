function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function stripOuterMarkdownFence(markdown) {
  const text = String(markdown ?? "").replace(/\r/g, "").trim();
  const fenceMatch = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1].trim() : text;
}

export function splitBriefingSections(markdown) {
  const lines = stripOuterMarkdownFence(markdown).replace(/\r/g, "").split("\n");
  const sections = [];
  let current = [];

  for (const line of lines) {
    if (/^##\s+/.test(line) && current.length) {
      sections.push(current.join("\n").trim());
      current = [line];
      continue;
    }

    current.push(line);
  }

  if (current.length) sections.push(current.join("\n").trim());
  return sections.filter(Boolean);
}

function parseMarkdownTable(lines) {
  if (lines.length < 2) return null;

  return lines
    .filter((line, index) => !(index === 1 && /^\|\s*[-:| ]+\|$/.test(line)))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

function renderMarkdownTable(lines) {
  const rows = parseMarkdownTable(lines);
  if (!rows) return `<p>${renderInlineMarkdown(lines.join(" "))}</p>`;

  const [header, ...body] = rows;
  return `<table><thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function renderBriefingSection(sectionMarkdown) {
  const lines = sectionMarkdown.replace(/\r/g, "").split("\n");
  const parts = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      parts.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      const tableLines = [];
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      parts.push(renderMarkdownTable(tableLines));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      parts.push(`<blockquote>${quoteLines.map((value) => renderInlineMarkdown(value)).join("<br>")}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      parts.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+[.)]\s+/, ""));
        index += 1;
      }
      parts.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current) {
        index += 1;
        break;
      }
      if (/^(#{1,3})\s+/.test(current) || /^\|.*\|$/.test(current) || /^>\s?/.test(current) || /^[-*]\s+/.test(current) || /^\d+[.)]\s+/.test(current)) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    parts.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return parts.join("");
}

export function renderBriefingHtml(markdown) {
  const sections = splitBriefingSections(markdown);
  return sections
    .map((section, index) => {
      const kicker = index === 0 ? `<div class="briefing-kicker">AI Generated Morning Read</div>` : "";
      return `<article class="briefing-section">${kicker}${renderBriefingSection(section)}</article>`;
    })
    .join("");
}
