import "./hello.css";

/** The placeholder window: what every window ticket replaces with the real thing. */
export default function Hello() {
  return (
    <div className="hello">
      <p className="hello-lead">Hello, Matthew.</p>
      <p>This window is a placeholder. The real one arrives in a later ticket.</p>
    </div>
  );
}
