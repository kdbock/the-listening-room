import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  stage: text("stage").notNull().default("Not started"),
  progress: integer("progress").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  narratorStatus: text("narrator_status").notNull().default("Not designed"),
  manuscriptReady: integer("manuscript_ready", { mode: "boolean" }).notNull().default(false),
  voiceApproved: integer("voice_approved", { mode: "boolean" }).notNull().default(false),
  testApproved: integer("test_approved", { mode: "boolean" }).notNull().default(false),
  settingsLocked: integer("settings_locked", { mode: "boolean" }).notNull().default(false),
  renderingComplete: integer("rendering_complete", { mode: "boolean" }).notNull().default(false),
  qaPassed: integer("qa_passed", { mode: "boolean" }).notNull().default(false),
  masterApproved: integer("master_approved", { mode: "boolean" }).notNull().default(false),
  episodesComplete: integer("episodes_complete").notNull().default(0),
  episodesTotal: integer("episodes_total").notNull().default(0),
  correctionsOpen: integer("corrections_open").notNull().default(0),
  nextAction: text("next_action").notNull().default("Choose the next production step"),
  targetDate: text("target_date").notNull().default(""),
  projectPath: text("project_path").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const materials = sqliteTable("materials", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category").notNull().default("Other"),
  contentType: text("content_type").notNull().default("application/octet-stream"),
  size: integer("size").notNull().default(0),
  storageKey: text("storage_key").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const sounds = sqliteTable("sounds", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull().default("Sound effect"),
  contentType: text("content_type").notNull().default("audio/mpeg"),
  size: integer("size").notNull().default(0),
  storageKey: text("storage_key").notNull().unique(),
  sourceUrl: text("source_url").notNull().default(""),
  license: text("license").notNull().default(""),
  attribution: text("attribution").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
});
