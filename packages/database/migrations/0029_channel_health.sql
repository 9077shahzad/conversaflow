-- 0029 Provider health and recovery screen (BRD v1.2 Wave 1). Viewing needs channels.monitor (owner, admin,
-- supervisor); recovery actions need channels.manage, which requires two-step sign-in.
INSERT INTO permissions (key, description, requires_mfa) VALUES
  ('channels.monitor', 'See the health of WhatsApp connections, sending and media downloads', false);
