CREATE TABLE "ToolCall" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "sessionId" TEXT NOT NULL REFERENCES "Session"("id") ON DELETE CASCADE,
  "phase" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "server" TEXT,
  "source" TEXT NOT NULL,
  "input" JSONB,
  "output" JSONB,
  "status" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ToolCall_sessionId_phase_callId_key" ON "ToolCall"("sessionId","phase","callId");
CREATE INDEX "ToolCall_name_id_idx" ON "ToolCall"("name","id");
CREATE INDEX "ToolCall_source_id_idx" ON "ToolCall"("source","id");
CREATE INDEX "ToolCall_phase_status_id_idx" ON "ToolCall"("phase","status","id");
CREATE VIRTUAL TABLE ToolCallSearch USING fts5(name, input, output, content='ToolCall', content_rowid='id');
CREATE TRIGGER tool_call_insert AFTER INSERT ON ToolCall BEGIN
  INSERT INTO ToolCallSearch(rowid,name,input,output) VALUES (new.id,new.name,new.input,new.output);
END;
CREATE TRIGGER tool_call_delete AFTER DELETE ON ToolCall BEGIN
  INSERT INTO ToolCallSearch(ToolCallSearch,rowid,name,input,output) VALUES ('delete',old.id,old.name,old.input,old.output);
END;
CREATE TRIGGER tool_call_update AFTER UPDATE ON ToolCall BEGIN
  INSERT INTO ToolCallSearch(ToolCallSearch,rowid,name,input,output) VALUES ('delete',old.id,old.name,old.input,old.output);
  INSERT INTO ToolCallSearch(rowid,name,input,output) VALUES (new.id,new.name,new.input,new.output);
END;
