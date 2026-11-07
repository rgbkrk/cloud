import { cloud_agent_repository_environment_defaults as table } from '@kilocode/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { ProfileDatabase, ProfileOwner, RepositoryPlatform } from './types';
import { canonicalRepoFullName } from './repo-binding-db';

export type RepositoryEnvironmentDefaultRow = {
  repositoryFullName: string;
  repositoryPlatform: RepositoryPlatform;
  environmentId: string;
};

type ReadDatabase = Pick<ProfileDatabase, 'select'>;

function ownerCondition(owner: ProfileOwner) {
  return owner.type === 'user'
    ? and(eq(table.owned_by_user_id, owner.id), sql`${table.owned_by_organization_id} IS NULL`)
    : and(eq(table.owned_by_organization_id, owner.id), sql`${table.owned_by_user_id} IS NULL`);
}

function ownerColumns(owner: ProfileOwner) {
  return owner.type === 'user'
    ? { owned_by_user_id: owner.id, owned_by_organization_id: null }
    : { owned_by_organization_id: owner.id, owned_by_user_id: null };
}

export async function getRepositoryEnvironmentDefaults(
  db: ReadDatabase,
  owner: ProfileOwner
): Promise<RepositoryEnvironmentDefaultRow[]> {
  return db
    .select({
      repositoryFullName: table.repository_full_name,
      repositoryPlatform: table.repository_platform,
      environmentId: table.environment_id,
    })
    .from(table)
    .where(ownerCondition(owner));
}

export async function getRepositoryEnvironmentDefault(
  db: ReadDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<string | null> {
  const [row] = await db
    .select({ environmentId: table.environment_id })
    .from(table)
    .where(
      and(
        ownerCondition(owner),
        eq(table.repository_full_name, canonicalRepoFullName(repoFullName)),
        eq(table.repository_platform, platform)
      )
    )
    .limit(1);
  return row?.environmentId ?? null;
}

export async function upsertRepositoryEnvironmentDefault(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform,
  environmentId: string
): Promise<void> {
  const values = {
    ...ownerColumns(owner),
    repository_full_name: canonicalRepoFullName(repoFullName),
    repository_platform: platform,
    environment_id: environmentId,
  };
  if (owner.type === 'user') {
    await db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({
        target: [table.owned_by_user_id, table.repository_full_name, table.repository_platform],
        targetWhere: isNotNull(table.owned_by_user_id),
        set: { environment_id: environmentId },
      });
    return;
  }
  await db
    .insert(table)
    .values(values)
    .onConflictDoUpdate({
      target: [
        table.owned_by_organization_id,
        table.repository_full_name,
        table.repository_platform,
      ],
      targetWhere: isNotNull(table.owned_by_organization_id),
      set: { environment_id: environmentId },
    });
}

export async function deleteRepositoryEnvironmentDefault(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<void> {
  await db
    .delete(table)
    .where(
      and(
        ownerCondition(owner),
        eq(table.repository_full_name, canonicalRepoFullName(repoFullName)),
        eq(table.repository_platform, platform)
      )
    );
}
