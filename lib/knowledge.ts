import matter from "gray-matter";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The help articles in /knowledge: one Markdown file each, with frontmatter
// (id, title, category, last_reviewed). Pages and the support agent both read them
// from here, so they always say the same thing.

const FOLDER = path.join(process.cwd(), "knowledge");

export type Article = {
  id: string;
  title: string;
  category: string;
  lastReviewed: string;
  body: string; // the Markdown below the article's "# Title" heading
};

export async function loadArticles(): Promise<Article[]> {
  const files = (await readdir(FOLDER)).filter((f) => f.endsWith(".md")).sort();
  return Promise.all(
    files.map(async (file) => {
      const { data, content } = matter(await readFile(path.join(FOLDER, file), "utf8"));
      if (typeof data.id !== "string" || typeof data.title !== "string") {
        throw new Error(`knowledge/${file}: frontmatter needs a text id and title`);
      }
      const reviewed = data.last_reviewed instanceof Date ? data.last_reviewed.toISOString().slice(0, 10) : String(data.last_reviewed ?? "");
      return {
        id: data.id,
        title: data.title,
        category: String(data.category ?? ""),
        lastReviewed: reviewed,
        body: content.trim().replace(/^# .*\n+/, ""),
      };
    }),
  );
}

// The named articles, in the order given. Fails loudly if any is missing, so a renamed
// or deleted article stops the build instead of quietly leaving a page incomplete.
export async function getArticles(ids: string[]): Promise<Article[]> {
  const all = await loadArticles();
  return ids.map((id) => {
    const article = all.find((a) => a.id === id);
    if (!article) throw new Error(`Help article "${id}" not found in /knowledge`);
    return article;
  });
}
