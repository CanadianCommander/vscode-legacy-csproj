import { XMLBuilder } from "fast-xml-parser";
import CsprojRawToCsprojMetaConverter from "../converter/csproj-raw-to-csproj-meta-converter";
import CsprojInclude from "../meta/csproj-include";
import { Uri, workspace } from "vscode";
import { logger } from "../../logger";
import CsprojReader from "./csproj-reader";
import CsprojPostProcessor from "./csproj-post-processor";
import { ConfigKey } from "../../config/config-key";
import { LineEnding } from "../../config/line-ending";

export default class CsprojWriter {
  private static readonly CSPROJ_WRITE_RETRY_TIMES: number = 8;

  private _csprojCache: Map<string, any> = new Map();

  // ========================================================
  // public methods
  // ========================================================

  /**
   * Create a new CsprojWriter
   * @param _buffer - [optional default false] whether or not to buffer the csproj in memory.
   *  You must call flush() to write the csproj to disk
   */
  constructor(private _buffer: boolean = false) {}

  /**
   * Write the given include to the csproj file at the given path
   * @param include - the include to write
   * @param csprojPath - the path to the csproj
   */
  public async writeIncludeToCsproj(
    include: CsprojInclude,
    csprojPath: string,
  ) {
    const csproj = await this.loadCsprojRaw(csprojPath);

    this.addIncludeToCsproj(include, csproj);

    if (!this._buffer) {
      await this.writeCsprojRaw(csprojPath, csproj);
    }
  }

  /**
   * Delete the given include from the csproj file at the given path
   * @param include - the include to delete
   * @param csprojPath - the path to the csproj
   */
  public async deleteIncludeFromCsproj(
    include: CsprojInclude,
    csprojPath: string,
  ): Promise<void> {
    const csproj = await this.loadCsprojRaw(csprojPath);

    this.removeInsertFromCsproj(include, csproj);

    if (!this._buffer) {
      await this.writeCsprojRaw(csprojPath, csproj);
    }
  }

  /**
   * Flush pending csproj changes to disk
   */
  public async flush(): Promise<void> {
    for (const [csprojPath, csproj] of this._csprojCache) {
      await this.writeCsprojRaw(csprojPath, csproj);
    }
    this._csprojCache.clear();
  }

  /**
   * Add a new include to the raw csproj
   * @param include - the include to add
   * @param csproj - the raw csproj to modify
   */
  public addIncludeToCsproj(include: CsprojInclude, csproj: any): void {
    const configIndent = this.buildIndentString();
    const csprojMeta = new CsprojRawToCsprojMetaConverter().convert(csproj);

    //if the include already exists, do nothing
    if (csprojMeta.containsInclude(include)) {
      return;
    }

    let biggestItemGroup = (csproj as Array<any>)
      .find((item) => !!item.Project)
      .Project.filter((projectItem: any) => !!projectItem.ItemGroup)
      .map((projectItem: any) => projectItem.ItemGroup)
      .reduce((biggest: any, curr: any) => {
        if (!biggest) {
          return curr;
        } else {
          const biggestSize = biggest.filter(
            (bigItem: any) => !!bigItem[include.type],
          ).length;
          const currSize = curr.filter(
            (currItem: any) => !!currItem[include.type],
          ).length;
          return biggestSize > currSize ? biggest : curr;
        }
      }, null);

    // if there is no item group, create one
    let indentation = `\n${configIndent}`;
    if (!biggestItemGroup) {
      biggestItemGroup = [{ "#text": `\n${configIndent}` }];
      const project = csproj.find((node: any) => !!node["Project"]).Project;
      project.push({ "#text": configIndent });
      project.push({ ItemGroup: biggestItemGroup });
      project.push({ "#text": "\n" });
    }

    // adjust indent level to match other items.
    const textItem = biggestItemGroup.findLast(
      (bigItem: any) => !!bigItem["#text"],
    );
    if (textItem) {
      indentation = textItem["#text"];
    }

    // add new item
    biggestItemGroup.push({
      "#text": configIndent,
    });
    biggestItemGroup.push({
      ":@": { "@_Include": include.include },
      [include.type]: [],
    });
    biggestItemGroup.push({
      "#text": indentation,
    });
  }

  /**
   * Remove the given include from the csproj
   * @param include - the include to remove
   * @param csproj - the csproj to modify
   */
  public removeInsertFromCsproj(include: CsprojInclude, csproj: any): void {
    (csproj as Array<any>)
      .find((item) => !!item.Project)
      .Project.filter((projectItem: any) => !!projectItem.ItemGroup)
      .map((projectItem: any) => projectItem.ItemGroup)
      .forEach((itemGroup: any) => {
        const deleteIndex = itemGroup.findIndex(
          (item: any) =>
            item[include.type] && item[":@"]["@_Include"] === include.include,
        );

        if (deleteIndex !== -1) {
          let delIndex = deleteIndex;
          let deleteCount = 1;

          // delete any text nodes that might proceed the include
          if (deleteIndex > 0 && itemGroup[deleteIndex - 1]["#text"]) {
            delIndex--;
            deleteCount++;
          }

          itemGroup.splice(delIndex, deleteCount);
        }
      });
  }

  // ========================================================
  // private methods
  // ========================================================

  /**
   * Load a raw csproj. Possibly from cache.
   * @param csprojPath - the path to the csproj
   * @returns - the raw csproj
   */
  private async loadCsprojRaw(csprojPath: string): Promise<any> {
    if (this._csprojCache.has(csprojPath) && this._buffer) {
      return this._csprojCache.get(csprojPath);
    } else {
      const csprojReader = new CsprojReader();
      const csproj = await csprojReader.loadCsprojRaw(csprojPath);
      this._csprojCache.set(csprojPath, csproj);
      return csproj;
    }
  }

  /**
   * Write the given raw csproj to disk
   * @param csprojPath - the path to the csproj
   * @param csproj - the csproj to write
   */
  private async writeCsprojRaw(csprojPath: string, csproj: any): Promise<void> {
    const csprojPostProcessor = new CsprojPostProcessor();
    const xmlWriter = new XMLBuilder({
      attributeNamePrefix: "@_",
      commentPropName: "#comment",
      ignoreAttributes: false,
      format: false,
      preserveOrder: true,
      suppressEmptyNode: true,
    });
    const lineEndings = workspace
      .getConfiguration(ConfigKey.Extension)
      .get(ConfigKey.LineEnding) as LineEnding;
    const applyVSCompatTransforms = workspace
      .getConfiguration(ConfigKey.Extension)
      .get(ConfigKey.VisualStudioCompatTransforms) as boolean;
    const emptyTagsToExpand = workspace
      .getConfiguration(ConfigKey.Extension)
      .get(ConfigKey.EmptyTagExpansion) as string[];

    for (let i = 0; i < CsprojWriter.CSPROJ_WRITE_RETRY_TIMES; i++) {
      try {
        workspace.fs.writeFile(
          Uri.file(csprojPath),
          Buffer.from(
            csprojPostProcessor.process(
              xmlWriter.build(csproj),
              lineEndings,
              applyVSCompatTransforms,
              emptyTagsToExpand,
            ),
          ),
        );
        break;
      } catch (err) {
        // Windows sometimes throws an error when writing to the csproj. because of
        // the stupid cannot write file because another process is using it error, Which linux doesn't have.
        // Why does windows have to be so lame?
        // Anyway, we try again a few times.
        logger.warn(`Got error while writing to csproj. Trying again: ${err}`);
      }

      if (i === CsprojWriter.CSPROJ_WRITE_RETRY_TIMES - 1) {
        throw new Error(
          `Failed to write to csproj after ${CsprojWriter.CSPROJ_WRITE_RETRY_TIMES} retries`,
        );
      }
    }
  }

  /**
   * Build an indent string based on the user's settings
   * @returns - the indent string (string of spaces)
   */
  private buildIndentString(): string {
    const indentSetting = workspace
      .getConfiguration(ConfigKey.Extension)
      .get(ConfigKey.Indent) as number;

    return Array.from({ length: indentSetting }, () => " ").join("");
  }
}
