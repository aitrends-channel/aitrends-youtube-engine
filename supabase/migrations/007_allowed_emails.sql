CREATE TABLE allowed_emails (
  email TEXT PRIMARY KEY
);

-- Seed with the owner's email
INSERT INTO allowed_emails (email) VALUES ('prioritylearn@gmail.com');
