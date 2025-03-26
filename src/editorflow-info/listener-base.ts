import { DocChangeInfo, EditorType, ProjectChangeInfo, FlowEventType } from './ext_models';
import { emitData } from './emitter';

export class ListenerBase {

  protected UNTITLED_PROJECT_TITLE: string = 'Untitled';
  protected UNNAMED_PROJECT_PATH: string = 'Unnamed';
  protected DEFAULT_DURATION: number = 60;
  protected DEFAULT_DURATION_MILLIS: number = this.DEFAULT_DURATION * 1000;

  protected listenReady: boolean = false; // util!!!

  protected iface: any = undefined;
  protected projectChangeInfo: ProjectChangeInfo | undefined = undefined;

  // project change info emit timeout
  private projectChangeInfoTimer: NodeJS.Timeout | undefined = undefined;

  private selectedType: EditorType | undefined = undefined;
  private lastKpmEmitTime: number = new Date().getTime();

  constructor(editor_interface: any, type: EditorType) {
    this.iface = editor_interface;
    this.selectedType = type;
    this.listenReady = true;
  }

  public isListenReady():boolean {
    return this.listenReady;
  }

  /**
   * This will create a doc change info object if one does not exist.
   * Along with the file change info wrapper that contains fileName to
   * DocChangeInfo associations.
   * @param fileName
   * @returns
   */
  protected getDocChangeInfo(fileName: string): DocChangeInfo {
    if (!this.projectChangeInfo) {
      this.projectChangeInfo = new ProjectChangeInfo();
    }

    // start the kpm timer if it's not already started
    if (!this.projectChangeInfoTimer) {
      // start the kpm timer
      this.projectChangeInfoTimer = setTimeout(() => {
        this.emitProjectChangeInfoData();
      }, this.DEFAULT_DURATION_MILLIS);
    }

    // create a new fileName key with the doc change info if it doesn't exist
    if (!this.projectChangeInfo.docs_changed[fileName]) {
      const docChangeInfo: DocChangeInfo = new DocChangeInfo();
      docChangeInfo.file_name = fileName;
      docChangeInfo.file_path = this.getRootPathForFile(fileName);

      // set the start time
      docChangeInfo.start = new Date().getTime();

      // add the file to the file change info map
      this.projectChangeInfo.docs_changed[fileName] = docChangeInfo;
    }
    return this.projectChangeInfo.docs_changed[fileName];
  }

  protected analyzeDocChange(docChangeInfo: DocChangeInfo, currentContentChanges: any[]) {
    for (const contentChange of currentContentChanges) {
      // get {linesAdded, linesDeleted, charactersDeleted, charactersAdded, changeType}
      const changeInfo = this.analyzeDocumentChange(contentChange);
      docChangeInfo.linesAdded += changeInfo.linesAdded;
      docChangeInfo.linesDeleted += changeInfo.linesDeleted;
      docChangeInfo.charactersAdded += changeInfo.charactersAdded;
      docChangeInfo.charactersDeleted += changeInfo.charactersDeleted;
      docChangeInfo.changeType = changeInfo.changeType;

      switch (changeInfo.changeType) {
        case 'singleDelete': {
          docChangeInfo.singleDeletes += 1;
          docChangeInfo.keystrokes += 1;
          break;
        }
        case 'multiDelete': {
          docChangeInfo.multiDeletes += 1;
          docChangeInfo.keystrokes += 1;
          break;
        }
        case 'singleAdd': {
          docChangeInfo.singleAdds += 1;
          docChangeInfo.keystrokes += 1;
          break;
        }
        case 'multiAdd': {
          docChangeInfo.multiAdds += 1;
          docChangeInfo.keystrokes += 1;
          break;
        }
        case 'autoIndent': {
          docChangeInfo.autoIndents += 1;
          docChangeInfo.keystrokes += 1;
          break;
        }
        case 'replacement': {
          docChangeInfo.replacements += 1;
          docChangeInfo.keystrokes += 1;
          break;
        }
      }
    }
  }

  private analyzeDocumentChange(contentChange: any) {
    const info: DocChangeInfo = new DocChangeInfo();

    // extract lines and character change counts
    this.extractVsCodeChangeCounts(info, contentChange);
    this.characterizeChange(info, contentChange);

    return info;
  }

  private extractVsCodeChangeCounts(changeInfo: DocChangeInfo, contentChange: any) {
    changeInfo.linesDeleted = contentChange.range.end.line - contentChange.range.start.line;
    changeInfo.linesAdded = contentChange.text?.match(/[\n\r]/g)?.length || 0;

    changeInfo.charactersDeleted = contentChange.rangeLength - changeInfo.linesDeleted;
    changeInfo.charactersAdded = contentChange.text.length - changeInfo.linesAdded;
  }

  private characterizeChange(changeInfo: DocChangeInfo, contentChange: any) {
    if (changeInfo.charactersDeleted > 0 || changeInfo.linesDeleted > 0) {
      if (changeInfo.charactersAdded > 0) {
        changeInfo.changeType = 'replacement';
      } else if (changeInfo.charactersDeleted > 1 || changeInfo.linesDeleted > 1) {
        changeInfo.changeType = 'multiDelete';
      } else if (changeInfo.charactersDeleted === 1 || changeInfo.linesDeleted === 1) {
        changeInfo.changeType = 'singleDelete';
      }
    } else if (changeInfo.charactersAdded > 1 || changeInfo.linesAdded > 1) {
      let hasAutoIndentMatch: boolean = (contentChange.text.match(/^[\n\r]\s*$/)?.length === 1);
      if (hasAutoIndentMatch) {
        // the regex matches a text that is a newline followed by only whitespace
        changeInfo.charactersAdded = 0;
        changeInfo.changeType = 'autoIndent';
      } else {
        changeInfo.changeType = 'multiAdd';
      }
    } else if (changeInfo.charactersAdded === 1 || changeInfo.linesAdded === 1) {
      changeInfo.changeType = 'singleAdd';
    }
  }

  public emitProjectChangeInfoData() {
    const one_minute_ago: number = new Date().getTime() - this.DEFAULT_DURATION_MILLIS;

    if (this.projectChangeInfoTimer) {
      // clear the timer if it exists
      clearTimeout(this.projectChangeInfoTimer);
      this.projectChangeInfoTimer = undefined;

      // ME: for all the changes?
      const kpmPayload = this.projectChangeInfo || null;
      if (kpmPayload && kpmPayload.docs_changed && Object.keys(kpmPayload.docs_changed).length) {
        // make sure project doc_changes have keystrokes
        const files = Object.keys(kpmPayload.docs_changed);
        for (const file of files) { // for each file  
          const docChangeInfo: DocChangeInfo = kpmPayload.docs_changed[file];
          if (docChangeInfo.keystrokes === 0) {
            // no keystroke stats, remove this DocChangeInfo
            delete kpmPayload.docs_changed[file];
            continue;
          }

          if (!docChangeInfo.start) {
            // !!!!!!!!!!!!!!! ensure there's a start time (but why wouldn't it have one already??) - whatever
            docChangeInfo.start = Math.max(this.lastKpmEmitTime + 500, one_minute_ago);
          }

          // set the end time if its not set
          if (!docChangeInfo.end || docChangeInfo.end <= docChangeInfo.start) {
            docChangeInfo.end = new Date().getTime();
          }
        }

        // check the length in case we've taken any zero keystroke files out
        if (Object.keys(kpmPayload.docs_changed).length) {
          // send the payload
          emitData(EditorType.VSCODE, FlowEventType.KPM, kpmPayload);
        }
      }

      // reset the data
      this.projectChangeInfo = undefined;
    }
    this.lastKpmEmitTime = new Date().getTime();
  }

  // cand ne-ar folosi asta?
  public endPreviousModifiedFiles(fileName: string) {
    if (this.projectChangeInfo && this.projectChangeInfo.docs_changed) {
      Object.keys(this.projectChangeInfo.docs_changed).forEach((key: string) => {
        if (this.projectChangeInfo) {
          const docChangeInfo: DocChangeInfo = this.projectChangeInfo.docs_changed[key];
          if (key !== fileName && docChangeInfo.end === 0) {
            docChangeInfo.end = new Date().getTime();
          }
        }
      });
    }
  }

  private getRootPathForFile(fileName: string): string {
    const folder = this.getVsCodeProjectFolder(fileName);
    if (folder) {
      return folder.uri.fsPath;
    }
    return this.UNNAMED_PROJECT_PATH;
  }

  private getVsCodeProjectFolder(fileName: string) {
    if (this.iface.workspace.workspaceFolders?.length) {
      for (const workspaceFolder of this.iface.workspace.workspaceFolders) {
        if (workspaceFolder.uri) {
          let isVslsScheme = !!(workspaceFolder.uri.scheme === 'vsls');
          let folderUri = workspaceFolder.uri;
          if (folderUri && folderUri.fsPath && !isVslsScheme && fileName.includes(folderUri.fsPath)) {
            return workspaceFolder;
          }
        }
      }
    }
    return null;
  }

}