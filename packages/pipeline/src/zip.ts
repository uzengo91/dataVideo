import { spawn } from "node:child_process";
import path from "node:path";

/** 用系统 zip 打包目录（macOS/linux 通用；Windows 需装 zip 或后续换 adm-zip） */
export function zipDir(dir: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("zip", ["-r", "-q", path.resolve(outFile), "."], { cwd: dir });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`zip 退出码 ${code}`))));
  });
}

export default zipDir;
