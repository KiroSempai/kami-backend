-- KAMI — Community Roles System
-- Migración para ampliar roles locales en community_members

ALTER TABLE community_members 
  ALTER COLUMN role TYPE VARCHAR(30),
  ALTER COLUMN role SET DEFAULT 'member';

UPDATE community_members cm
SET role = 'creator'
FROM communities c
WHERE cm.community_id = c.id AND cm.user_id = c.created_by
  AND cm.role != 'creator';

CREATE TABLE IF NOT EXISTS community_role_permissions (
    role VARCHAR(30) PRIMARY KEY,
    can_moderate_posts BOOLEAN DEFAULT false,
    can_manage_roles BOOLEAN DEFAULT false,
    can_edit_community BOOLEAN DEFAULT false,
    can_ban_members BOOLEAN DEFAULT false
);

INSERT INTO community_role_permissions VALUES
  ('creator', true, true, true, true),
  ('moderator', true, false, false, true),
  ('member', false, false, false, false)
ON CONFLICT (role) DO NOTHING;
