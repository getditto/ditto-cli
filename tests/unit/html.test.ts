import { describe, expect, it } from "vitest";
import { renderHtml } from "../../src/render/html.js";

describe("renderHtml", () => {
  it("renders a self-contained HTML document", () => {
    const out = renderHtml([{ _id: "1", title: "Alien" }]);
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain("<style>");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>_id</th>");
    expect(out).toContain("<th>title</th>");
    expect(out).toContain("<td>Alien</td>");
    expect(out).toContain("1 row");
  });

  it("puts _id first, then union of keys in first-seen order", () => {
    const out = renderHtml([
      { title: "Alien", _id: "1" },
      { _id: "2", rated: "R" },
    ]);
    const head = out.match(/<thead>.*<\/thead>/s)![0];
    expect(head.indexOf("_id")).toBeLessThan(head.indexOf("title"));
    expect(head.indexOf("title")).toBeLessThan(head.indexOf("rated"));
  });

  it("HTML-escapes cell content and keys", () => {
    const out = renderHtml([{ "<script>": '<b>x</b> & "y"' }]);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;");
  });

  it("renders nested objects as compact JSON", () => {
    const out = renderHtml([{ _id: "1", loc: { city: "Seattle" } }]);
    expect(out).toContain("{&quot;city&quot;:&quot;Seattle&quot;}");
  });

  it("renders empty rows as a table with no body rows", () => {
    const out = renderHtml([]);
    expect(out).toContain("<table>");
    expect(out).toContain("0 rows");
  });
});
