import "server-only";
import type { TicketTemplate } from "@prisma/client";
import type { DesignMime } from "./design-file";
import type { RenderTemplate } from "./render";
import { loadFile } from "./storage";
import type { TemplateLayout } from "./template-layout";

export async function toRenderTemplate(t: TicketTemplate, layout?: TemplateLayout): Promise<RenderTemplate> {
  return {
    bytes: await loadFile(t.backgroundPath),
    mime: t.backgroundMime as DesignMime,
    widthMm: t.widthMm,
    heightMm: t.heightMm,
    layout: layout ?? (t.layout as TemplateLayout),
  };
}
