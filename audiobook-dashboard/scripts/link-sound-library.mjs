import fs from "node:fs";
import path from "node:path";

const dashboardRoot = process.cwd();
const projectRoot = path.resolve(dashboardRoot, "..");
const source = path.join(projectRoot, "Sound Library Downloads");
const publicRoot = path.join(dashboardRoot, "public");
const target = path.join(publicRoot, "sound-library");

if (!fs.existsSync(source)) {
  console.warn(`Sound library folder not found; preview audio will be unavailable: ${source}`);
  process.exit(0);
}

fs.mkdirSync(publicRoot, { recursive: true });

if (fs.existsSync(target)) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    const linkedTo = fs.readlinkSync(target);
    const resolvedLink = path.resolve(path.dirname(target), linkedTo);
    if (resolvedLink === source) {
      console.log(`Sound library preview link already exists: ${target}`);
      process.exit(0);
    }
    fs.unlinkSync(target);
  } else {
    console.error(`Cannot create sound library link because this path already exists and is not a symlink: ${target}`);
    process.exit(1);
  }
}

const relativeSource = path.relative(publicRoot, source);
fs.symlinkSync(relativeSource, target, "dir");
console.log(`Linked ${target} -> ${relativeSource}`);
