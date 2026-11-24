import * as React from 'react';

/**
 * A native <details> whose body renders only once it has been opened, then
 * stays mounted. Long lists of collapsed rows cost one <summary> each until
 * someone expands them.
 */
export function LazyDetails({ summary, children, onToggle, open, ...props }: Omit<React.ComponentPropsWithoutRef<'details'>, 'children'> & { summary: React.ReactNode; children: React.ReactNode }) {
  const [opened, setOpened] = React.useState(Boolean(open));
  return (
    <details
      {...props}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
        onToggle?.(event);
      }}
    >
      {summary}
      {(opened || open) && children}
    </details>
  );
}
