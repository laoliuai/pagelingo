import type { ButtonHTMLAttributes } from 'react';
export function Button({
  primary,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button className={`button ${primary ? 'primary' : ''} ${className}`} {...props} />;
}
