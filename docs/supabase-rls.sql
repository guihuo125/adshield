-- AdShield 云端数据的行级安全策略（RLS）
--
-- 隐私政策里对外承诺的「每个账号只能读写属于自己的那一行，
-- 未登录的匿名请求即使持有扩展内置的公开密钥，读取结果也为空」，
-- 靠的就是这份策略。扩展里只有公开的客户端密钥（sb_publishable_*），
-- 密钥本身不构成任何授权 —— 真正的边界在这两张表上，不在客户端代码里。
--
-- 部署：Supabase 控制台 -> SQL Editor -> 整段粘贴执行。
-- 前提：两张表都已有 user_id 列，存的是 Supabase auth 的用户 id。
-- 若 user_id 是 uuid 类型，把下面的 auth.uid()::text = user_id::text 换成 auth.uid() = user_id。

-- ===== adshield_configs：每个用户一行，存云端同步的配置 =====
alter table public.adshield_configs enable row level security;

drop policy if exists "configs_select_own" on public.adshield_configs;
create policy "configs_select_own" on public.adshield_configs
  for select to authenticated
  using (auth.uid()::text = user_id::text);

drop policy if exists "configs_insert_own" on public.adshield_configs;
create policy "configs_insert_own" on public.adshield_configs
  for insert to authenticated
  with check (auth.uid()::text = user_id::text);

drop policy if exists "configs_update_own" on public.adshield_configs;
create policy "configs_update_own" on public.adshield_configs
  for update to authenticated
  using (auth.uid()::text = user_id::text)
  with check (auth.uid()::text = user_id::text);

drop policy if exists "configs_delete_own" on public.adshield_configs;
create policy "configs_delete_own" on public.adshield_configs
  for delete to authenticated
  using (auth.uid()::text = user_id::text);

-- ===== adshield_devices：每个用户多行，存登录过的设备 =====
alter table public.adshield_devices enable row level security;

drop policy if exists "devices_select_own" on public.adshield_devices;
create policy "devices_select_own" on public.adshield_devices
  for select to authenticated
  using (auth.uid()::text = user_id::text);

drop policy if exists "devices_insert_own" on public.adshield_devices;
create policy "devices_insert_own" on public.adshield_devices
  for insert to authenticated
  with check (auth.uid()::text = user_id::text);

drop policy if exists "devices_update_own" on public.adshield_devices;
create policy "devices_update_own" on public.adshield_devices
  for update to authenticated
  using (auth.uid()::text = user_id::text)
  with check (auth.uid()::text = user_id::text);

drop policy if exists "devices_delete_own" on public.adshield_devices;
create policy "devices_delete_own" on public.adshield_devices
  for delete to authenticated
  using (auth.uid()::text = user_id::text);

-- 验证方法：
--   1. 用你的账号登录后，在 SQL Editor 里跑
--        select auth.uid()::text;                       -- 应是你的 user id
--        select count(*) from adshield_configs;          -- 应为 1（只有自己那一行）
--        select count(*) from adshield_devices;          -- 应为自己的设备数
--   2. 只带 apikey、不带 Authorization 的匿名请求读同样的表，应得到 0 行。
--      扩展里那个公开密钥属于匿名角色，上面所有策略都只对 authenticated 生效。
