import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getArticles } from "@/lib/knowledge";

export const metadata: Metadata = { title: "Privacy · Travel Planner" };

// The privacy page is made from these help articles, so it always matches what the
// support agent says. Edit the articles in /knowledge to change it.
const PRIVACY_ARTICLES = ["what-data-we-store", "who-can-see-my-data", "delete-account"];

export default async function PrivacyPage() {
  const articles = await getArticles(PRIVACY_ARTICLES);
  const lastReviewed = articles.map((a) => a.lastReviewed).sort().at(-1);

  return (
    <main className="doc">
      <article className="doc-card">
        <a href="/" className="small">
          ← Back to Travel Planner
        </a>
        <h1>Privacy</h1>
        {lastReviewed && <p className="small">Last reviewed {lastReviewed}</p>}

        {articles.map((article) => (
          <section key={article.id} id={article.id} className="doc-section markdown">
            <h2>{article.title}</h2>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{article.body}</ReactMarkdown>
            {article.id === "delete-account" && (
              <p>
                <a href="/account/delete" className="danger-button">
                  Delete my account and data
                </a>
              </p>
            )}
          </section>
        ))}
      </article>
    </main>
  );
}
