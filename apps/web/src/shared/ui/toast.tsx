import { useEffect, useRef } from 'react';
export function Feedback({ message, error = false }: { message: string; error?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message && error) ref.current?.focus();
  }, [message, error]);
  return message ? (
    <p
      ref={ref}
      className={`feedback ${error ? 'error' : ''}`}
      role={error ? 'alert' : 'status'}
      tabIndex={-1}
    >
      {message}
    </p>
  ) : null;
}
