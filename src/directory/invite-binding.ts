// An account may remove only the grant observed at creation. Older account
// rows have no binding: their invitation generation is deliberately unknown.
export const INVITE_BINDING_MIGRATIONS: string[] = [
  `CREATE TABLE account_invite_bindings (user_id TEXT PRIMARY KEY, email TEXT NOT NULL, generation TEXT)`,
  `CREATE TRIGGER remove_account_invite_binding AFTER DELETE ON users
   BEGIN DELETE FROM account_invite_bindings WHERE user_id=OLD.user_id; END`,
  `ALTER TABLE invite_deletion_receipts ADD COLUMN binding_verified INTEGER NOT NULL DEFAULT 0 CHECK(binding_verified IN (0,1))`,
  // Old finalizers know only the previous permit. Require an additional
  // transaction-scoped marker so they cannot bypass the generation binding.
  `CREATE TABLE invite_delete_authorizations_v2 (email TEXT PRIMARY KEY)`,
  `CREATE TRIGGER guard_invite_delete_authorization_v2 BEFORE INSERT ON invite_delete_authorizations
   WHEN NOT EXISTS(SELECT 1 FROM invite_delete_authorizations_v2 WHERE email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_delete_authorization_v2_required'); END`,
];
