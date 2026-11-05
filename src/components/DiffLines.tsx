interface Props {
  text: string;
  className?: string;
  empty?: string;
}

export function DiffLines({ text, className = "diff", empty }: Props) {
  if (!text.trim()) {
    return <p className="muted pad">{empty ?? "无内容"}</p>;
  }
  return (
    <pre className={className}>
      {text.split("\n").map((line, i) => (
        <span key={i} className={lineClass(line)}>
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "";
}
