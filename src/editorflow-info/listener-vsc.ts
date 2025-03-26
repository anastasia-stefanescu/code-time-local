import FileStatInfo from '../models/file_stat_info';
import {emitData} from '../util/emitter';
import { logIt } from '../util/logger';
import {VSCodeInterface, FlowEventType, DocChangeInfo, EditorType} from '../models/ext_models';
import { ListenerBase } from './listener-base';

export class VscodeListener extends ListenerBase {

  // file name => FileStatInfo
  private fileStatInfoMap: any = {};

  private subscriptions: any[] = [];

  private disposable: any;

  constructor(iface: VSCodeInterface) {
    super(iface, EditorType.VSCODE);

    // document listener handlers
    this.subscriptions.push(this.iface.workspace.onDidOpenTextDocument(this.onOpenHandler, this));
    this.subscriptions.push(this.iface.workspace.onDidCloseTextDocument(this.onCloseHandler, this));
    this.subscriptions.push(this.iface.workspace.onDidChangeTextDocument(this.onEventHandler, this));
    this.subscriptions.push(this.iface.workspace.onDidSaveTextDocument(this.onSaveHandler, this));

    // window state changed handler
    this.subscriptions.push(this.iface.window.onDidChangeWindowState(this.windowStateChanged, this));

    // theme color change handler
    this.subscriptions.push(this.iface.window.onDidChangeActiveColorTheme(this.colorThemeChanged, this));

    this.disposable = this.iface.disposable.from(...this.subscriptions);
    logIt('Initialized VscodeListener');
  }

  dispose() {
    if (this.disposable) {
      this.disposable.dispose();
    }
  }

  getSubscriptions(): any[] {
    return this.subscriptions;
  }

  getFileStatInfo(fileName: string): FileStatInfo {
    return this.fileStatInfoMap[fileName];
  }

  // ---------------------- //
  // Event Listener Methods //
  // ---------------------- //

  private onCloseHandler(event: any) {
    if (!event || !this.iface.window.state.focused) { // de ce verificam asta??
      return;
    }

    const fileName = event.fileName;
    if (!this.isTrueEventFile(event.uri, fileName, true)) {
      return;
    }
    this.getDocChangeInfo(fileName);

    emitData(EditorType.VSCODE, FlowEventType.CLOSE, this.projectChangeInfo, event);
  }

  /**
   * File Open Handler
   * @param event
   */
  protected onOpenHandler(event: any) {
    if (!event || !this.iface.window.state.focused) {
      return;
    }

    const fileName = event.fileName;
    if (!this.isTrueEventFile(event.uri, fileName)) {
      return;
    }

    // make sure other files end times are set
    this.endPreviousModifiedFiles(fileName); // -> inchidem celelalte file, clar nu se mai modifica acolo

    const docChangeInfo: DocChangeInfo = this.getDocChangeInfo(fileName);

    emitData(EditorType.VSCODE, FlowEventType.OPEN, this.projectChangeInfo, event);

    const statInfo: FileStatInfo = this.getStaticEventInfo(event, fileName);

    this.updateStaticValues(docChangeInfo, statInfo);
  }

  protected onSaveHandler(event: any) {
    this.getDocChangeInfo(event.fileName);
    emitData(EditorType.VSCODE, FlowEventType.SAVE, this.projectChangeInfo, event);
  }

  protected onEventHandler(event: any) {
    if (!event?.document || !this.iface.window.state.focused) {
      return;
    }

    const fileName = event.document.fileName;

    if (!this.isTrueEventFile(event.document.uri, fileName)) {
      return;
    }

    const docChangeInfo: DocChangeInfo = this.getDocChangeInfo(fileName);

    if (!docChangeInfo) {
      // it's undefined, it wasn't created
      return;
    }

    this.updateStaticValues(docChangeInfo, this.getStaticEventInfo(event, fileName));

    // get the content ranges that have a valid "range"
    const contentChanges: any[] = event.contentChanges.filter((change: any) => change.range);

    this.analyzeDocChange(docChangeInfo, contentChanges);

    emitData(EditorType.VSCODE, FlowEventType.CHANGE, this.projectChangeInfo, event);
  }

  protected windowStateChanged(event: any) {
    if (event.focused) {
      emitData(EditorType.VSCODE, FlowEventType.FOCUS, null, event);
    } else if (event.active) {
      // window is not focused, but still active
      // Process this window's keystroke data since the window has become unfocused
      emitData(EditorType.VSCODE, FlowEventType.UNFOCUS, null, event);
      this.emitProjectChangeInfoData();
    }
  }

  /*
   * event = ColorTheme
   * ColorTheme: {kind: ColorThemeKind}
   * ColorThemeKind: Light = 1 | Dark = 2 | HighContrast = 3
   */
  private colorThemeChanged(event: any) {
    emitData(EditorType.VSCODE, FlowEventType.THEME, null, event);
  }

  // ---------------------- //
  // Private Helper Methods //
  // ---------------------- //

  private isTrueEventFile(uri: any, fileName: string, isCloseEvent = false) {
    if (!fileName) {
      return false;
    }

    let scheme = '';
    if (uri && uri.scheme) {
      scheme = uri.scheme;
    }

    // we'll get 'git' as a scheme, but these are the schemes that match to open files in the editor
    const isDocEventScheme = scheme === 'file' || scheme === 'untitled' || scheme.includes('vscode-');

    const isLiveshareTmpFile = fileName.match(/.*\.code-workspace.*vsliveshare.*tmp-.*/);

    // return false that its not a doc that we want to track based on the
    // following conditions: non-doc scheme, is liveshare tmp file
    if (!isDocEventScheme || isLiveshareTmpFile) {
      return false;
    }

    return true;
  }

  private getStaticEventInfo(event: any, fileName: string): FileStatInfo {
    let fileStatInfo: FileStatInfo = this.getFileStatInfo(fileName);
    if (fileStatInfo) {
      return fileStatInfo;
    }

    const textDoc = event.document || event;
    const languageId = textDoc.languageId || textDoc.fileName.split('.').slice(-1)[0];
    let length = 0;
    if (typeof textDoc.getText === 'function') {
      length = textDoc.getText().length;
    }
    const lineCount = textDoc.lineCount || 0;

    fileStatInfo = {
      fileName,
      languageId,
      length,
      lineCount,
    };

    this.fileStatInfoMap[fileName] = fileStatInfo;
    return fileStatInfo;
  }

  private updateStaticValues(docChangeInfo: DocChangeInfo, statInfo: FileStatInfo) {
    // syntax
    if (!docChangeInfo.syntax) {
      docChangeInfo.syntax = statInfo.languageId;
    }

    // length
    if (!docChangeInfo.character_count) {
      docChangeInfo.character_count = statInfo.length;
    }
  }
}