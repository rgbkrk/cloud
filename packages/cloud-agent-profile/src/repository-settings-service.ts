import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { cloud_agent_environments } from '@kilocode/db/schema';
import type { ProfileDatabase, ProfileOwner, RepositoryPlatform } from './types';
import { withProfileTransaction } from './database';
import {
  buildEnvironmentOwnershipCondition,
  environmentContainsRepositoryFullName,
  selectActiveEnvironments,
} from './environment-lookup';
import type { EnvironmentTransaction } from './environment-service';
import {
  deleteRepositoryEnvironmentDefault,
  getRepositoryEnvironmentDefault,
  upsertRepositoryEnvironmentDefault,
} from './repository-environment-defaults-db';
import { bindProfileToRepo, removeRepoBinding } from './repo-binding-service';
import {
  clearRepoSandboxAllocation,
  setRepoSandboxAllocation,
} from './sandbox-allocation-settings-service';

export type RepositorySettingsInput = {
  profileId?: string | null;
  allocation?: string | null;
  /**
   * The repository's default environment. `undefined` preserves the stored
   * default, `null` clears it, and a changed string is validated and replaces it.
   */
  environmentId?: string | null;
};

/**
 * A newly chosen default must belong to the same owner and contain the
 * repository. A stored default that is left unchanged is not revalidated, even
 * when the client resends its id, so a stale or deleted environment cannot
 * block an unrelated profile or allocation edit.
 */
async function assertDefaultEnvironmentContainsRepository(
  tx: EnvironmentTransaction,
  owner: ProfileOwner,
  environmentId: string,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<void> {
  const owned = and(
    eq(cloud_agent_environments.id, environmentId),
    buildEnvironmentOwnershipCondition(owner)
  );
  const [environment] = await selectActiveEnvironments(tx, owned);
  if (!environment) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }

  const [containing] = await selectActiveEnvironments(
    tx,
    and(owned, environmentContainsRepositoryFullName(repoFullName, platform))
  );
  if (!containing) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The selected environment does not contain this repository',
    });
  }
}

/**
 * Applies a repository's environment default, profile binding and allocation
 * override in one transaction. An empty field clears that half independently;
 * `environmentId` replaces the default only when it differs, and omitting it
 * preserves the stored default. Clearing everything removes all three
 * idempotently.
 */
export async function setRepositorySettings(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform,
  input: RepositorySettingsInput
): Promise<void> {
  await withProfileTransaction(db, async tx => {
    if (input.environmentId === null) {
      await deleteRepositoryEnvironmentDefault(tx, owner, repoFullName, platform);
    } else if (input.environmentId !== undefined) {
      const currentEnvironmentId = await getRepositoryEnvironmentDefault(
        tx,
        owner,
        repoFullName,
        platform
      );
      if (input.environmentId !== currentEnvironmentId) {
        await assertDefaultEnvironmentContainsRepository(
          tx,
          owner,
          input.environmentId,
          repoFullName,
          platform
        );
        await upsertRepositoryEnvironmentDefault(
          tx,
          owner,
          repoFullName,
          platform,
          input.environmentId
        );
      }
    }
    if (input.allocation) {
      await setRepoSandboxAllocation(tx, owner, repoFullName, platform, input.allocation);
    } else {
      await clearRepoSandboxAllocation(tx, owner, repoFullName, platform);
    }
    if (input.profileId) {
      await bindProfileToRepo(tx, owner, repoFullName, platform, input.profileId);
    } else {
      await removeRepoBinding(tx, owner, repoFullName, platform);
    }
  });
}

export async function removeRepositorySettings(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<void> {
  // Same row order as setRepositorySettings (default, allocation, then binding),
  // so two concurrent writes for one repository cannot lock the rows in
  // opposite order.
  await withProfileTransaction(db, async tx => {
    await deleteRepositoryEnvironmentDefault(tx, owner, repoFullName, platform);
    await clearRepoSandboxAllocation(tx, owner, repoFullName, platform);
    await removeRepoBinding(tx, owner, repoFullName, platform);
  });
}
