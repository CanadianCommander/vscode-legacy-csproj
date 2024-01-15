import * as vscode from "vscode";
import AbstractEventListener from "./abstract-event-listener";
import CsprojService from "../../csproj/csproj-service";

export default class FileCreatedListener extends AbstractEventListener {
  // ========================================================
  // public methods
  // ========================================================

  // listen for events
  public bind(): void {
    this.disposable = vscode.workspace.onDidCreateFiles(
      async (fileEvent: vscode.FileCreateEvent) => {
        const csprojService = new CsprojService();

        for (const file of fileEvent.files) {
          if (
            (await vscode.workspace.fs.stat(file)).type === vscode.FileType.File
          ) {
            csprojService.addFileToCsproj(file.fsPath);
          }
        }
      },
    );

    // auto cleanup when extension is deactivated
    this.extensionContext.subscriptions.push(this.disposable);
  }

  // stop listening for events
  public unbind(): void {
    this.disposable?.dispose();
  }
}
