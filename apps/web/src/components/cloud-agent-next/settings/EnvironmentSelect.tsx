'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCloudAgentEnvironments,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';
import { cn } from '@/lib/utils';

const AUTOMATIC = 'automatic';

type EnvironmentSelectProps = {
  environmentId: string | null;
  organizationId?: string;
  repository: EnvironmentRepository;
  labelledBy: string;
  disabled: boolean;
  onChange: (environmentId: string | null) => void;
};

export function EnvironmentSelect({
  environmentId,
  organizationId,
  repository,
  labelledBy,
  disabled,
  onChange,
}: EnvironmentSelectProps) {
  const helpId = useId();
  const query = useCloudAgentEnvironments({ organizationId, repository });
  const environments = query.data ?? [];
  const listed = environments.find(environment => environment.id === environmentId);
  const unavailable = environmentId !== null && query.isSuccess && !listed;
  const name = query.isLoading
    ? 'Loading environments...'
    : environmentId
      ? (listed?.name ?? (query.isError ? 'Saved environment' : 'Unavailable environment'))
      : 'Automatic';

  return (
    <>
      <Select
        value={environmentId ?? AUTOMATIC}
        onValueChange={next => onChange(next === AUTOMATIC ? null : next)}
        disabled={disabled || query.isLoading}
      >
        <SelectTrigger
          className="w-full pointer-coarse:min-h-11"
          aria-labelledby={labelledBy}
          aria-describedby={helpId}
          aria-invalid={unavailable || undefined}
        >
          <SelectValue className="min-w-0">
            <span className={cn('truncate', !environmentId && 'text-muted-foreground')}>
              {name}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
          {environmentId && !listed && (
            <SelectItem value={environmentId} disabled>
              {name}
            </SelectItem>
          )}
          {environments.map(environment => (
            <SelectItem key={environment.id} value={environment.id}>
              {environment.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        id={helpId}
        className={cn('text-xs', unavailable ? 'text-destructive' : 'text-muted-foreground')}
      >
        {unavailable ? (
          'This default is unavailable. Choose another environment or Automatic.'
        ) : query.isError ? (
          <>
            Could not load environments.{' '}
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </>
        ) : listed?.sandboxAllocation ? (
          'The environment sandbox takes precedence over the repository sandbox.'
        ) : listed ? (
          'Used for sessions without an environment selection.'
        ) : environments.length === 0 && query.isSuccess ? (
          'No environments contain this repository.'
        ) : (
          'Automatic uses the only matching environment, if there is one.'
        )}
      </p>
    </>
  );
}
