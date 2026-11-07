import 'server-only';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import {
  ORGANIZATION_MANAGE_ROLES,
  canManageOrganization,
} from '@kilocode/app-shared/organizations';
import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import {
  SELECTABLE_SANDBOX_ALLOCATIONS,
  sandboxSelectionCapabilitiesSchema,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  BuiltinAgentSettingsInputSchema,
  canonicalRepoFullName,
  clearContextSandboxAllocation,
  getBuiltinAgentSettings,
  getRepositoryEnvironmentDefault,
  getRepositoryEnvironmentDefaults,
  getSandboxAllocationSettings,
  listBindings,
  listEnvironments,
  removeRepositorySettings,
  setBuiltinAgentSettings,
  setContextSandboxAllocation,
  setRepositorySettings,
  type ProfileOwner,
  type RepositoryPlatform,
} from '@kilocode/cloud-agent-profile';
import {
  assertAllocationOffered,
  findSandboxOption,
  getSavedAllocationReason,
  loadSandboxCapabilities,
} from '@/lib/cloud-agent-next/sandbox-allocation-offers';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { canonicalGitLabProjectUrl } from '@/lib/cloud-agent/environment-repository-input';

const RepositoryPlatformSchema = z.enum(['github', 'gitlab']);

const RepositorySettingsRowSchema = z.object({
  repositoryFullName: z.string(),
  repositoryPlatform: RepositoryPlatformSchema,
  profileId: z.uuid().nullable(),
  profileName: z.string().nullable(),
  environmentId: z.uuid().nullable(),
  allocation: z.string().nullable(),
  allocationUnavailableReason: z.string().optional(),
  allocationRepositoryUnavailableReason: z.string().optional(),
});

const CloudAgentSettingsSchema = z.object({
  canManage: z.boolean(),
  contextAllocation: z.string().nullable(),
  contextUnavailableReason: z.string().optional(),
  builtinAgents: BuiltinAgentSettingsInputSchema,
  repositories: z.array(RepositorySettingsRowSchema),
  capabilities: sandboxSelectionCapabilitiesSchema,
  // Repository-scoped capability views so a GitLab row never offers a
  // GitHub-only allocation such as Vercel.
  capabilitiesByPlatform: z.object({
    github: sandboxSelectionCapabilitiesSchema,
    gitlab: sandboxSelectionCapabilitiesSchema,
  }),
});

function ownerFromInput(organizationId: string | undefined, userId: string): ProfileOwner {
  return organizationId
    ? { type: 'organization', id: organizationId }
    : { type: 'user', id: userId };
}

function toRepositoryPlatform(platform: string): RepositoryPlatform {
  return platform === 'gitlab' ? 'gitlab' : 'github';
}

export const cloudAgentSettingsRouter = createTRPCRouter({
  canManage: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional() }))
    .output(z.object({ canManage: z.boolean() }))
    .query(async ({ ctx, input }) => {
      if (!input.organizationId) return { canManage: true };
      const role = await ensureOrganizationAccess(ctx, input.organizationId);
      return { canManage: canManageOrganization(role) };
    }),

  get: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional() }))
    .output(CloudAgentSettingsSchema)
    .query(async ({ ctx, input }) => {
      const organizationId = input.organizationId;
      const role = organizationId ? await ensureOrganizationAccess(ctx, organizationId) : undefined;
      const canManage = role ? canManageOrganization(role) : true;
      const owner = ownerFromInput(organizationId, ctx.user.id);

      const [capabilities, settings, bindings, builtinAgents, environmentDefaults] =
        await Promise.all([
          loadSandboxCapabilities(ctx.user, ctx.headersList, organizationId),
          getSandboxAllocationSettings(db, owner),
          listBindings(db, owner),
          getBuiltinAgentSettings(db, ctx.user.id),
          getRepositoryEnvironmentDefaults(db, owner),
        ]);

      const rows = new Map<string, z.infer<typeof RepositorySettingsRowSchema>>();
      const rowKey = (fullName: string, platform: RepositoryPlatform) =>
        `${platform}:${fullName.toLowerCase()}`;

      for (const binding of bindings) {
        const platform = toRepositoryPlatform(binding.platform);
        const key = rowKey(binding.repoFullName, platform);
        rows.set(key, {
          repositoryFullName: binding.repoFullName,
          repositoryPlatform: platform,
          profileId: binding.profileId,
          profileName: binding.profileName,
          environmentId: null,
          allocation: null,
        });
      }

      for (const setting of settings.repositories) {
        const key = rowKey(setting.repositoryFullName, setting.repositoryPlatform);
        const existing = rows.get(key);
        rows.set(key, {
          repositoryFullName: existing?.repositoryFullName ?? setting.repositoryFullName,
          repositoryPlatform: setting.repositoryPlatform,
          profileId: existing?.profileId ?? null,
          profileName: existing?.profileName ?? null,
          environmentId: null,
          allocation: setting.allocation,
        });
      }

      for (const setting of environmentDefaults) {
        const key = rowKey(setting.repositoryFullName, setting.repositoryPlatform);
        const existing = rows.get(key);
        rows.set(key, {
          repositoryFullName: existing?.repositoryFullName ?? setting.repositoryFullName,
          repositoryPlatform: setting.repositoryPlatform,
          profileId: existing?.profileId ?? null,
          profileName: existing?.profileName ?? null,
          allocation: existing?.allocation ?? null,
          environmentId: setting.environmentId,
        });
      }

      const repositoryPlatforms: RepositoryPlatform[] = ['github', 'gitlab'];
      const repositoryCapabilities = new Map<RepositoryPlatform, SandboxSelectionCapabilities>();
      await Promise.all(
        repositoryPlatforms.map(async platform => {
          const caps = await loadSandboxCapabilities(
            ctx.user,
            ctx.headersList,
            organizationId,
            platform
          );
          repositoryCapabilities.set(platform, caps);
        })
      );

      const repositories = [...rows.values()]
        .map(row => {
          if (!row.allocation) return row;
          const caps = repositoryCapabilities.get(row.repositoryPlatform) ?? capabilities;
          const ownerReason = getSavedAllocationReason(capabilities, row.allocation);
          const repositoryReason = findSandboxOption(
            caps,
            row.allocation
          )?.repositoryUnavailableReason;
          return {
            ...row,
            ...(ownerReason ? { allocationUnavailableReason: ownerReason } : {}),
            ...(repositoryReason
              ? { allocationRepositoryUnavailableReason: repositoryReason }
              : {}),
          };
        })
        .sort(
          (a, b) =>
            a.repositoryFullName.localeCompare(b.repositoryFullName) ||
            a.repositoryPlatform.localeCompare(b.repositoryPlatform)
        );

      const contextReason = settings.contextAllocation
        ? getSavedAllocationReason(capabilities, settings.contextAllocation)
        : undefined;

      return {
        canManage,
        contextAllocation: settings.contextAllocation,
        ...(contextReason ? { contextUnavailableReason: contextReason } : {}),
        builtinAgents,
        repositories,
        capabilities,
        capabilitiesByPlatform: {
          github: repositoryCapabilities.get('github') ?? capabilities,
          gitlab: repositoryCapabilities.get('gitlab') ?? capabilities,
        },
      };
    }),

  setContextAllocation: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        allocation: z.enum(SELECTABLE_SANDBOX_ALLOCATIONS).nullable(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const owner = ownerFromInput(input.organizationId, ctx.user.id);

      if (input.allocation === null) {
        await clearContextSandboxAllocation(db, owner);
        return { success: true };
      }

      const capabilities = await loadSandboxCapabilities(
        ctx.user,
        ctx.headersList,
        input.organizationId
      );
      assertAllocationOffered(capabilities, input.allocation);
      await setContextSandboxAllocation(db, owner, input.allocation);
      return { success: true };
    }),

  setRepositorySettings: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        repoFullName: z.string().min(1).max(500),
        platform: RepositoryPlatformSchema,
        profileId: z.uuid().nullable().optional(),
        environmentId: z.uuid().nullable().optional(),
        allocation: z.enum(SELECTABLE_SANDBOX_ALLOCATIONS).nullable().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const owner = ownerFromInput(input.organizationId, ctx.user.id);

      // Validate only a newly chosen allocation. A saved allocation that is left
      // unchanged while the profile is edited or cleared may already be stale or
      // unavailable; re-validating it would block an unrelated profile change.
      if (input.allocation) {
        const currentAllocation = (await getSandboxAllocationSettings(db, owner)).repositories.find(
          row =>
            row.repositoryPlatform === input.platform &&
            row.repositoryFullName === canonicalRepoFullName(input.repoFullName)
        )?.allocation;
        if (input.allocation !== currentAllocation) {
          const capabilities = await loadSandboxCapabilities(
            ctx.user,
            ctx.headersList,
            input.organizationId,
            input.platform
          );
          assertAllocationOffered(capabilities, input.allocation, input.platform);
        }
      }

      if (
        input.environmentId &&
        input.platform === 'gitlab' &&
        input.environmentId !==
          (await getRepositoryEnvironmentDefault(db, owner, input.repoFullName, input.platform))
      ) {
        const cloneUrl = await canonicalGitLabProjectUrl(
          input.repoFullName,
          ctx.user.id,
          input.organizationId
        );
        const environments = await listEnvironments(db, owner, { platform: 'gitlab', cloneUrl });
        if (!environments.some(environment => environment.id === input.environmentId)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'The selected environment does not contain this repository on your GitLab instance',
          });
        }
      }

      await setRepositorySettings(db, owner, input.repoFullName, input.platform, {
        profileId: input.profileId ?? null,
        allocation: input.allocation ?? null,
        environmentId: input.environmentId,
      });
      return { success: true };
    }),

  setBuiltinAgents: baseProcedure
    .input(z.object({ agents: BuiltinAgentSettingsInputSchema }))
    .output(z.object({ success: z.boolean(), agents: BuiltinAgentSettingsInputSchema }))
    .mutation(async ({ ctx, input }) => {
      const agents = await setBuiltinAgentSettings(db, ctx.user.id, input.agents);
      return { success: true, agents };
    }),

  removeRepositorySettings: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        repoFullName: z.string().min(1).max(500),
        platform: RepositoryPlatformSchema,
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }
      const owner = ownerFromInput(input.organizationId, ctx.user.id);
      await removeRepositorySettings(db, owner, input.repoFullName, input.platform);
      return { success: true };
    }),
});
