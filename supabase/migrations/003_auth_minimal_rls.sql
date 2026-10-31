-- =====================================================================
-- 003_auth_minimal_rls.sql | Minimal RLS policies needed for login (Phase 2a)
-- Covers: profiles, roles, role_permissions, branches, user_branches
-- Full module-by-module RLS policies will be applied in Phase 2b.
-- =====================================================================

-- 1. profiles: users can view and update their own profile; Admins can view all
create policy profiles_select_own on profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1 from profiles p join roles r on r.id = p.role_id
      where p.id = auth.uid() and r.name = 'Admin' and p.deleted_at is null
    )
  );

create policy profiles_update_own on profiles
  for update using (
    id = auth.uid()
    or exists (
      select 1 from profiles p join roles r on r.id = p.role_id
      where p.id = auth.uid() and r.name = 'Admin' and p.deleted_at is null
    )
  );

-- 2. roles: authenticated users can read roles to determine access
create policy roles_select_authenticated on roles
  for select using (auth.uid() is not null);

-- 3. role_permissions: authenticated users can read permissions
create policy role_permissions_select_authenticated on role_permissions
  for select using (auth.uid() is not null);

-- 4. user_branches: users can view their own branch assignments
create policy user_branches_select_own on user_branches
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from profiles p join roles r on r.id = p.role_id
      where p.id = auth.uid() and r.name = 'Admin' and p.deleted_at is null
    )
  );

-- 5. branches: users can view branches they have access to or all if main/admin
create policy branches_select_assigned on branches
  for select using (
    is_main = true
    or user_has_branch(id)
  );
