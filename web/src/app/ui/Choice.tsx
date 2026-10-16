/** A large segmented choice: every option at least 44 points tall, the chosen one filled. */
export function Choice<T extends string | number | boolean>({ options, value, onChange, label }: {
  options: { value: T; title: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.title}
        </button>
      ))}
    </div>
  );
}
