ALTER TABLE Session ADD COLUMN parentSessionId TEXT REFERENCES Session(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE Session ADD COLUMN rootSessionId TEXT;
ALTER TABLE Session ADD COLUMN branchEntryId TEXT;
ALTER TABLE Session ADD COLUMN branchRequestId TEXT;
ALTER TABLE Session ADD COLUMN promptCheckpointReady BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE Session ADD COLUMN checkpointImage TEXT;
CREATE UNIQUE INDEX Session_branchRequestId_key ON Session(branchRequestId);
CREATE INDEX Session_parentSessionId_idx ON Session(parentSessionId);
CREATE INDEX Session_rootSessionId_idx ON Session(rootSessionId);
