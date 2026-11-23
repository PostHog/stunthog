ALTER TABLE "ToolCall" ADD COLUMN "tool" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ToolCall" ADD COLUMN "serverIndex" INTEGER;
CREATE INDEX "ToolCall_serverIndex_tool_idx" ON "ToolCall"("serverIndex","tool");
