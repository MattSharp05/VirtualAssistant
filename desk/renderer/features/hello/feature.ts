import type { FeatureMeta } from "../types";

/** A placeholder window (JD-20): proves the feature pattern and stands in for windows not built yet. */
const hello: FeatureMeta = {
  id: "hello",
  title: "Hello",
  icon: "spark",
  minSize: { width: 320, height: 220 },
  defaultSize: { width: 480, height: 320 },
};
export default hello;
