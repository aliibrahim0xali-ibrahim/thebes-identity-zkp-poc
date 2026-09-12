export default function Banner({ kind = "info", children }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}
