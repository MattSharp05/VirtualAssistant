import type { NotionPageRef } from "@jarvis/shared";
import { FullView } from "../../app/FullView";

/** The page on notion.so: the link Notion gave, or one built from its id. */
export function notionUrl(page: NotionPageRef): string {
  return page.url?.startsWith("https://") ? page.url : `https://www.notion.so/${page.id}`;
}

/** Full view (JD-39): the real notion.so page inside the window, editable. */
export function NotionFullView({ page }: { page: NotionPageRef }) {
  return <FullView url={notionUrl(page)} site="notion.so" name={page.title} />;
}
