import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cn } from '../src/lib/utils.js';

test('shared controls accept size overrides while preserving color and font-size tokens', () => {
  assert.equal(cn('h-9 w-9 px-3 text-sm bg-surface', 'h-11 w-11 px-0 text-base bg-primary-button'), 'h-11 w-11 px-0 text-base bg-primary-button');
  assert.equal(cn('text-sm text-muted', 'text-primary'), 'text-sm text-primary');
  assert.equal(cn('border border-border-2', 'border-danger'), 'border border-danger');
});

test('Tailwind 4 variable shorthand and state-specific overrides merge independently', () => {
  assert.equal(cn('bg-(--card-bg)', 'bg-(--popover-bg)'), 'bg-(--popover-bg)');
  assert.equal(
    cn('bg-surface hover:bg-surface data-[state=checked]:translate-x-5', 'hover:bg-surface-2 data-[state=checked]:translate-x-0.5'),
    'bg-surface hover:bg-surface-2 data-[state=checked]:translate-x-0.5',
  );
});
