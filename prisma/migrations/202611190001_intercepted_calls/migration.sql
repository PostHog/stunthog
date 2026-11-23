-- Poll session counts without reading the response bodies.
CREATE INDEX "SessionEvent_modified_call_idx"
ON "SessionEvent" ("sessionId", json_extract("event", '$.callId'))
WHERE "phase" = 'response' AND json_type("event", '$.ruleId') = 'text';
