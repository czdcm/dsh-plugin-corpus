/**
 * dsh-plugin-corpus — 客户端半部（v1.3 面板 + 右栏语料权限 + 主页面语料导入区）。
 *
 * 注册点：
 *   sidebar.panellist          左侧栏一行（图标 + label），点它进入主页面
 *   main                       主区域整页（key = 同一个 panel id；含 v1.3 导入区）
 *   sidebarRightTabs.register  右栏 tab 类型 + guide（开始菜单「语料权限」入口）
 *   sidebar.right.pane.tab     右栏 body（key = 上面的 tab id，Session scope 拿 sessionId）
 *
 * 与宿主通过插件自己的 HTTP 路由通信（第三方客户端 bundle 没有 Remote 面）：
 *   GET  /api/dsh-plugin-corpus/overview
 *   POST /api/dsh-plugin-corpus/search
 *   POST /api/dsh-plugin-corpus/read
 *   GET  /api/dsh-plugin-corpus/status
 *   POST /api/dsh-plugin-corpus/reindex
 *   GET  /api/dsh-plugin-corpus/files      （契约端点，面板暂未用到）
 *   GET  /api/dsh-plugin-corpus/policy     （写权限前读当前策略）
 *   POST /api/dsh-plugin-corpus/policy     （右栏权限面板保存策略）
 *   GET  /api/dsh-plugin-corpus/access     （右栏权限面板：当前会话有效范围 + 策略）
 *   GET  /api/dsh-plugin-corpus/import/targets（主页面导入区：集合/格式/提取器/上限）
 *   POST /api/dsh-plugin-corpus/import     （主页面导入区：files 或 path 二选一）
 *   GET  /api/dsh-plugin-corpus/import/status（主页面导入区：1s 轮询进度）
 *
 * 注册幂等：bundle 若被执行两次，第二次直接跳过，不让 Web 启动失败。
 */
;(function () {
  if (window.__DSH_CORPUS_REGISTERED__ === true) return
  window.__DSH_CORPUS_REGISTERED__ = true
  window.__ModuleLoader__.load({
    // 必须是包名：客户端模块表以包名作为行 id 查找工厂
    id: 'dsh-plugin-corpus',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      const React = require('react')
      const h = React.createElement

      const PANEL_ID = 'corpus'
      const NS = 'dsh-corpus'
      const PAGE_LINES = 60
      const POLL_MS = 800
      const PERMISSIONS_TAB_ID = 'dsh-plugin-corpus-permissions'
      const PERMISSIONS_KIND = 'corpus-permissions'
      const PERMISSIONS_GUIDE_ID = 'permissions'
      const PREVIEW_TAB_ID = 'dsh-plugin-corpus-preview'
      const PREVIEW_KIND = 'corpus-preview'
      const PREVIEW_GUIDE_ID = 'preview'
      let previewRequest = null
      const previewSubscribers = new Set()
      const publishPreview = (request) => {
        previewRequest = request
        for (const subscriber of previewSubscribers) {
          try { subscriber(request) } catch { /* 单个订阅失败不影响其他 */ }
        }
      }
      // v1.3 主页面「导入语料」区：入口在页面头部，1s 轮询导入进度。
      const IMPORT_POLL_MS = 1000
      const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
      const MAX_FILES = 20
      // 契约里 extract.js 的 SUPPORTED_EXTENSIONS；/import/targets 未返回时作兜底。
      const DEFAULT_FORMATS = ['.md', '.markdown', '.txt', '.text', '.html', '.htm', '.pdf', '.docx', '.xlsx', '.pptx', '.csv']

      // 契约：GET 读、POST 写/检索；全部 JSON，同源。
      const API = {
        overview: '/api/dsh-plugin-corpus/overview',
        files: '/api/dsh-plugin-corpus/files',
        search: '/api/dsh-plugin-corpus/search',
        read: '/api/dsh-plugin-corpus/read',
        reindex: '/api/dsh-plugin-corpus/reindex',
        status: '/api/dsh-plugin-corpus/status',
        policy: '/api/dsh-plugin-corpus/policy',
        access: '/api/dsh-plugin-corpus/access',
        importTargets: '/api/dsh-plugin-corpus/import/targets',
        importStart: '/api/dsh-plugin-corpus/import',
        importStatus: '/api/dsh-plugin-corpus/import/status',
        originals: '/api/dsh-plugin-corpus/originals',
        original: '/api/dsh-plugin-corpus/original',
        thumbnail: '/api/dsh-plugin-corpus/thumbnail',
        gallery: '/api/dsh-plugin-corpus/gallery',
        delete: '/api/dsh-plugin-corpus/delete',
        settings: '/api/dsh-plugin-corpus/settings',
        settingsRoot: '/api/dsh-plugin-corpus/settings/root',
        settingsOpen: '/api/dsh-plugin-corpus/settings/open',
        openExternal: '/api/dsh-plugin-corpus/open-external',
      }

      const COPY = {
        zh: {
          nav: '语料库',
          title: '语料库',
          desc: '浏览与检索本机语料索引；重建在后台执行，进度会在这里显示。',
          refresh: '刷新',
          loading: '加载中…',
          failed: '操作失败：',
          networkFailed: '网络请求失败：',
          root: '语料根',
          overviewFailed: '无法加载语料库概况：',
          overviewUnavailable: '概况不可用，点上方「刷新」重试。',
          statsCollections: '集合',
          statsDocs: '文档',
          statsChunks: '块',
          statsIndex: '索引体积',
          searchTitle: '检索',
          searchPlaceholder: '输入关键词，多个词用空格分隔（全部命中）',
          search: '搜索',
          searching: '搜索中…',
          collectionLabel: '集合',
          workspaceLabel: '工作区视角',
          allCollections: '全部集合',
          allWorkspaces: '全部工作区',
          emptyQuery: '请输入关键词再搜索。',
          results: '搜索结果',
          hitUnit: (count) => `${count} 条`,
          noResults: '没有命中任何片段。',
          scope: '检索范围',
          lines: '行',
          score: '评分',
          preview: '预览',
          previewTabTitle: '语料查看',
          previewEmpty: '点击文件列表中的语料，在这里查看内容。',
          close: '关闭',
          prevPage: '上一页',
          nextPage: '下一页',
          externalOpen: '用外部软件打开',
          externalOpenChoose: '选择其他应用…',
          externalOpenFailed: '外部打开失败：',
          pageInfo: (from, to, total) => `行 ${from}–${to} / ${total}`,
          readFailed: '读取失败：',
          collectionsTitle: '集合与索引',
          backend: '后端',
          docs: '文档',
          chunks: '块',
          indexedAt: '索引时间',
          indexBytes: '索引体积',
          bytes: '原文体积',
          reindex: '重建',
          reindexing: '重建中…',
          reindexAll: '增量重建全部',
          reindexForceAll: '全量重建全部',
          confirmForce: '确认全量重建',
          cancel: '取消',
          started: '已启动重建任务，后台进行中。',
          busy: '已有重建任务在执行，请等它结束。',
          locked: (pid) => `另一个进程（pid ${pid}）正在重建索引。`,
          lockedUnknown: '另一个进程正在重建索引。',
          jobDone: '重建完成。',
          jobError: '重建失败：',
          pollFailed: '查询重建状态失败：',
          progress: '重建中：',
          jobRange: '范围',
          progressLine: (collection, index, total) => `${collection} ${index}/${total}`,
          forceMode: '全量',
          incremental: '增量',
          recentJob: '最近任务',
          jobRunning: '执行中',
          jobStateDone: '完成',
          jobStateError: '失败',
          jobUnit: (ms) => `${ms} ms`,
          policyTitle: '访问策略',
          policyFile: '策略文件',
          policyStatus: '状态',
          policyExists: '已加载',
          policyMissing: '不存在',
          policyDefault: '默认动作',
          policyGrants: '授权规则',
          policyDeny: '拒绝规则',
          policyGlobal: '全局规则',
          policySubjectWorkspace: '工作区',
          policySubjectSession: '会话',
          policyNoGrants: '没有授权规则。',
          policyNoDeny: '没有拒绝规则。',
          policyFallback: '策略文件不存在时的回落规则（v1.0）：只允许各工作区自己的 corpus/。',
          policyParseError: '策略文件解析失败：',
          policyReadonly: '只读展示；修改请编辑策略文件，等缓存过期（15 秒）或重启后生效。',
          policyUnavailable: '访问策略暂不可用（概况未加载）。',
          openPermissions: '在右侧栏编辑权限',
          openPermissionsHint: '右栏服务不可用，无法打开「语料权限」面板。',
          openPermissionsRequested: '已在右侧栏打开「语料权限」。',
          permTitle: '语料权限',
          permDesc: '查看并编辑当前会话、工作区与全局的语料访问规则',
          permSession: '当前会话',
          permSessionId: '会话',
          permEffective: '有效集合',
          permNoEffective: '当前会话没有可访问的集合。',
          permSessionRules: '会话规则',
          permNoSessionRules: '还没有会话专属规则。',
          permWorkspace: '当前工作区',
          permWorkspaceRules: '工作区规则',
          permNoWorkspaceRules: '还没有当前工作区的规则。',
          permWorkspaceUnavailable: '没有可用的工作区（会话未提供工作目录），无法新增工作区规则。',
          permGlobal: '全局',
          permDefaultLabel: '默认动作',
          permDefaultAllow: '允许',
          permDefaultDeny: '拒绝',
          permDefaultHint: '切换立即保存；deny 始终优先于 allow。',
          permDenyRules: '拒绝规则',
          permNoDenyRules: '还没有拒绝规则。',
          permOtherRules: '其他规则',
          permOtherHint: '不是当前会话/工作区、也不是全局的规则：只读展示，可删除。',
          permNoOtherRules: '没有其他规则。',
          permPathsPlaceholder: '集合或文件路径，逗号或换行分隔',
          permPathsRequired: '请先填写路径（集合名、目录前缀或文件路径）。',
          permExpiry: '有效期',
          permExpireNever: '永久',
          permExpire30: '30 分钟',
          permExpire60: '1 小时',
          permExpire1440: '24 小时',
          permExpire10080: '7 天',
          permExpireUntil: '有效期至',
          permExpireExpired: '已过期',
          permGrantSession: '授予当前会话',
          permGrantWorkspace: '授予当前工作区',
          permAddDeny: '添加全局拒绝',
          permDelete: '删除',
          permLoading: '正在加载访问信息…',
          permRetry: '重试',
          permLoadFailed: '无法加载访问信息：',
          permNoSession: '没有会话上下文，无法加载会话权限。',
          permPolicyError: '策略文件问题：',
          permSaved: '策略已保存。',
          permRuleAdded: '规则已添加。',
          permRuleDeleted: '规则已删除。',
          permDefaultSaved: '默认动作已保存。',
          permDenyAdded: '拒绝规则已添加。',
          permValidationFailed: '策略校验失败：',
          permCollections: '集合快捷填入',
          permAccessFile: '策略文件',
          permBackupHint: '保存前会自动把旧策略备份到 DSH 目录的 backups/ 下。',
          permEffectHint: '工具下一次调用生效，提示词最多 15 秒更新。',
          permBusy: '保存中…',
          // ---- v1.3 右栏「语料导入」 ----
          importTitle: '语料导入',
          importDesc: '把文档导入语料库：提取正文 →（可选）AI 结构化 → 写入集合 → 重建索引。',
          importSource: '来源',
          importModeFiles: '浏览器文件',
          importModePath: '本机路径',
          importChooseFiles: '选择文件（可多选）',
          importFilesHint: '可一次选择多个文件；它们会作为同一批导入同一个集合。单个文件不超过上限，大文件建议用本机路径。',
          importNoFiles: '还没有选择文件。',
          importRemoveFile: '删除',
          importReading: '正在读取文件…',
          importFilesAdded: (count) => `已添加 ${count} 个文件，将批量导入同一个集合。`,
          importUnsupported: '不支持的格式：',
          importTooLarge: '超过大小上限：',
          importTooMany: '文件数量超过上限：',
          importReadFailed: '读取文件失败：',
          importPathLabel: '本机路径（可多行）',
          importPathPlaceholder: 'C:\\docs\\manual.pdf\nC:\\docs\\handbook\\\nC:\\docs\\appendix.pdf',
          importPathHint: '每行一个文件或目录；目录会递归扫描支持格式。多行路径会批量导入同一个集合。',
          importPathRequired: '请填写本机路径（文件或目录，可多行）。',
          importTarget: '目标',
          importCollection: '目标集合',
          importPickCollection: '选择或输入集合名',
          importNoCollections: '语料根下还没有集合；可直接输入新集合名，导入时会自动创建。',
          importNewCollectionHint: '可直接输入新集合名；导入时会在语料根下自动创建同名目录。名称仅限字母/数字/._-（≤64 字符）；模型读取新集合仍需在右栏「语料权限」授权。',
          importAutoCollectionHint: '留空会自动创建 import-日期-时间 集合，批量文件全部进入该集合。',
          importNeedCollection: '请选择或输入目标集合。',
          settingsTitle: '语料库根目录',
          settingsDesc: '集合、索引、原件和缩略图都在这个目录里；可把整个语料库搬到新位置。',
          settingsCurrent: '当前根目录',
          settingsCopy: '复制路径',
          settingsCopied: '路径已复制。',
          settingsOpen: '在资源管理器中打开',
          settingsChange: '更改位置',
          settingsClose: '收起设置',
          settingsNewPath: '新根目录（绝对路径）',
          settingsNewPlaceholder: '例如 D:\\MyCorpus 或 C:\\Users\\你\\Documents\\corpus',
          settingsMigrate: '迁移语料库',
          settingsConfirm: '再点一次确认迁移：会移动所有集合、索引和原件。',
          settingsMigrating: '正在迁移…',
          settingsDone: '迁移完成。',
          settingsRestart: '数据已复制到新位置；重启 DSH 后会使用新根目录（旧目录保留，可重启后手动清理）。',
          settingsError: '迁移失败：',
          settingsBusy: '还有导入/重建任务在运行，等任务结束后再迁移。',
          settingsNeedPath: '请先填写新的根目录绝对路径。',
          settingsOpenFailed: '打开文件夹失败：',
          settingsLoadError: '读取根目录设置失败：',
          settingsStateFile: '设置文件',
          importPrefix: '前缀（可选）',
          importPrefixPlaceholder: '例如 guides/',
          importOptions: '选项',
          importAiTitle: 'AI 结构化',
          importAiHint: '使用默认模型，耗时随文档长度增加。',
          importAiUnavailable: 'AI 不可用（没有可用的默认模型），将回退确定性 Markdown。',
          importStart: '开始导入',
          importRunning: '导入中…',
          importBusy: '已有导入任务在执行，请等它结束。',
          importStarted: '导入任务已启动，进度每秒刷新。',
          importProgress: '导入进度',
          importStage: '阶段',
          importStageExtract: '提取文本',
          importStageAgent: 'AI 结构化',
          importStageWrite: '写入语料',
          importStageIndex: '建立索引',
          importStageError: '出错',
          importCurrent: '当前文件',
          importCounts: '进度',
          importSucceeded: '成功',
          importFailed: '失败',
          importDone: '导入完成。',
          importJobError: '导入失败：',
          importResult: '导入结果',
          importReindex: '重建任务',
          importPollFailed: '查询导入状态失败：',
          importTargetsLoading: '正在加载导入目标…',
          importTargetsFailed: '无法加载导入目标：',
          importFormatsTitle: '支持格式',
          importExtractorsTitle: '文档提取器',
          importAvailable: '可用',
          importMissing: '不可用',
          importPdfHint: 'PDF 提取不可用：插件内没有随包 pdftotext（仅 Windows x64 有），可设置 CORPUS_PDFTOTEXT 指向外部 pdftotext。',
          importPdfOcrHint: '扫描版 PDF 会自动用插件内置的 Windows OCR；图片格式会交给内置小代理做图片理解。',
          importOfficeHint: 'Office（docx/xlsx/pptx）优先用随包 officecli 提取，失败回退纯 JS 解析器，不依赖外部安装。',
          importOcrHint: '当前系统没有可用的 Windows OCR：扫描版 PDF 可能只能拿到空文本。',
          importVisionHint: '当前模型/运行时不支持图片输入：图片会退化为内置 Windows OCR（若可用）。请在 DSH「设置 → 模型 → 该模型 → 模型选项 → 输入类型」勾选“图片”并保存；也可配置 ingestVisionProvider/ingestVisionModel。',
          importVisionReason: '不可用原因：',
          importLimitHint: (size, count) => `单文件 ≤ ${size}，最多 ${count} 个文件；大文件建议用本机路径。`,
          importErrorNote: '操作失败：',
          importOpen: '导入语料',
          importClose: '收起导入',
          galleryTitle: '语料文件',
          galleryDesc: '按集合分组的文件列表；图标优先用 Windows 缩略图，纯文本按已知扩展名显示 TXT/MD/PDF 等对应文件图标。点击一行打开提取结果。',
          galleryFilter: '集合范围',
          galleryAll: '全部集合',
          galleryCount: (total, shown) => `共 ${total} 篇，显示 ${shown} 篇`,
          galleryName: '名称',
          galleryType: '类型',
          galleryAction: '操作',
          galleryDocsUnit: '篇',
          galleryExpandAll: '全部展开',
          galleryCollapseAll: '全部折叠',
          galleryExpandHint: '点击集合名展开/折叠；删除单篇语料用行尾「删除」按钮。',
          galleryCollapsed: '已折叠',
          deleteRow: '删除',
          deleteRowConfirm: '确认',
          galleryOpen: '打开语料',
          galleryProcessed: '处理后语料（默认）',
          galleryOriginal: '原文件',
          galleryOriginalMissing: '无原文件',
          galleryDefaultOpen: '用默认程序直接打开',
          galleryChooseWith: '选择软件打开',
          galleryNoDocs: '还没有可展示的语料；用「导入语料」或在主会话里调用 corpus_structure 后，这里会出现文件列表。',
          reindexHelpTitle: '重建按钮说明',
          reindexHelpIntro: '两个按钮都会重建当前有权限集合的索引，但成本不同：',
          reindexHelpIncremental: '增量重建全部：扫描所有集合的 processed 文件，只重新索引新增/修改/删除的文档，未变化的文档保留已有分块；日常更新用这个，速度快。',
          reindexHelpForce: '全量重建全部：丢弃现有索引，重新切分并重建所有集合的全部分块；适合索引损坏、修改了切块/索引规则、或大规模改动之后，速度慢。',
          reindexHelpClose: '知道了',
          deleteDoc: '删除这篇语料',
          deleteDocConfirm: '确认删除（移到回收站）',
          deleteCollection: '删除集合',
          deleteCollectionConfirm: '确认删除集合（移到回收站）',
          deleteDone: '已删除，内容移到 .corpus/trash，可在那里恢复。',
          deleteCollectionDone: '集合已删除，移到 .corpus/trash/collections。',
          deleteFailed: '删除失败：',
          trashHint: '删除是软删除：内容移到语料根下 .corpus/trash/<时间>/，需要时可手动恢复。',
          galleryRefresh: '刷新语料',
          galleryLoading: '正在加载语料…',
          galleryError: '加载语料失败：',
          galleryEmpty: '还没有导入原件。用上方「导入语料」导入图片或文档。',
          galleryViewProcessed: '查看提取结果',
          galleryClose: '关闭',
          galleryAi: 'AI 结构化',
          galleryOriginal: '原件',
          galleryCollection: '集合',
          gallerySize: '大小',
          galleryImported: '导入时间',
          noCollections: '语料根下还没有集合。',
          foot: '检索与读取都在服务端完成；面板只展示语料目录内的内容。',
        },
        en: {
          nav: 'Corpus',
          title: 'Corpus',
          desc: 'Browse and search the local corpus index; rebuilds run in the background and report progress here.',
          refresh: 'Refresh',
          loading: 'Loading…',
          failed: 'Failed: ',
          networkFailed: 'Network request failed: ',
          root: 'Corpus root',
          overviewFailed: 'Could not load corpus overview: ',
          overviewUnavailable: 'Overview unavailable; press Refresh above to retry.',
          statsCollections: 'Collections',
          statsDocs: 'Docs',
          statsChunks: 'Chunks',
          statsIndex: 'Index size',
          searchTitle: 'Search',
          searchPlaceholder: 'Keywords; separate with spaces (all must match)',
          search: 'Search',
          searching: 'Searching…',
          collectionLabel: 'Collection',
          workspaceLabel: 'Workspace view',
          allCollections: 'All collections',
          allWorkspaces: 'All workspaces',
          emptyQuery: 'Enter keywords to search.',
          results: 'Results',
          hitUnit: (count) => `${count} hit(s)`,
          noResults: 'No matching chunks.',
          scope: 'Scope',
          lines: 'lines',
          score: 'score',
          preview: 'Preview',
          previewTabTitle: 'Corpus preview',
          previewEmpty: 'Click a corpus file in the list to view it here.',
          close: 'Close',
          prevPage: 'Previous',
          nextPage: 'Next',
          externalOpen: 'Open in external app',
          externalOpenChoose: 'Choose another app…',
          externalOpenFailed: 'External open failed: ',
          pageInfo: (from, to, total) => `lines ${from}–${to} / ${total}`,
          readFailed: 'Could not read file: ',
          collectionsTitle: 'Collections & indexes',
          backend: 'backend',
          docs: 'docs',
          chunks: 'chunks',
          indexedAt: 'indexed',
          indexBytes: 'index size',
          bytes: 'source size',
          reindex: 'Rebuild',
          reindexing: 'Rebuilding…',
          reindexAll: 'Rebuild all',
          reindexForceAll: 'Full rebuild all',
          confirmForce: 'Confirm full rebuild',
          cancel: 'Cancel',
          started: 'Rebuild job started in the background.',
          busy: 'A rebuild job is already running; wait for it to finish.',
          locked: (pid) => `Another process (pid ${pid}) is rebuilding the index.`,
          lockedUnknown: 'Another process is rebuilding the index.',
          jobDone: 'Rebuild finished.',
          jobError: 'Rebuild failed: ',
          pollFailed: 'Could not poll rebuild status: ',
          progress: 'Rebuilding:',
          jobRange: 'range',
          progressLine: (collection, index, total) => `${collection} ${index}/${total}`,
          forceMode: 'full',
          incremental: 'incremental',
          recentJob: 'Last job',
          jobRunning: 'running',
          jobStateDone: 'done',
          jobStateError: 'error',
          jobUnit: (ms) => `${ms} ms`,
          policyTitle: 'Access policy',
          policyFile: 'Policy file',
          policyStatus: 'Status',
          policyExists: 'loaded',
          policyMissing: 'not found',
          policyDefault: 'Default',
          policyGrants: 'Grants',
          policyDeny: 'Deny rules',
          policyGlobal: 'global rule',
          policySubjectWorkspace: 'workspace',
          policySubjectSession: 'session',
          policyNoGrants: 'No grant rules.',
          policyNoDeny: 'No deny rules.',
          policyFallback: 'v1.0 fallback when the policy file is missing: only each workspace\'s own corpus/ is allowed.',
          policyParseError: 'Could not parse policy file: ',
          policyReadonly: 'Read-only; edit the policy file and wait for the 15s cache to expire or restart.',
          policyUnavailable: 'Access policy unavailable (overview not loaded).',
          openPermissions: 'Edit permissions in right sidebar',
          openPermissionsHint: 'The right sidebar service is unavailable; the permissions panel cannot open.',
          openPermissionsRequested: 'Opened the permissions panel in the right sidebar.',
          permTitle: 'Corpus permissions',
          permDesc: 'View and edit corpus access rules for this session, workspace and global policy',
          permSession: 'Current session',
          permSessionId: 'Session',
          permEffective: 'Effective collections',
          permNoEffective: 'This session can reach no collections.',
          permSessionRules: 'Session rules',
          permNoSessionRules: 'No session-specific rules yet.',
          permWorkspace: 'Current workspace',
          permWorkspaceRules: 'Workspace rules',
          permNoWorkspaceRules: 'No rules for this workspace yet.',
          permWorkspaceUnavailable: 'No workspace available (the session has no working directory); workspace rules cannot be added.',
          permGlobal: 'Global',
          permDefaultLabel: 'Default',
          permDefaultAllow: 'Allow',
          permDefaultDeny: 'Deny',
          permDefaultHint: 'The switch saves immediately; deny always wins over allow.',
          permDenyRules: 'Deny rules',
          permNoDenyRules: 'No deny rules yet.',
          permOtherRules: 'Other rules',
          permOtherHint: 'Rules that belong to neither this session/workspace nor global policy: read-only, deletable.',
          permNoOtherRules: 'No other rules.',
          permPathsPlaceholder: 'Collection or file paths, separated by commas or newlines',
          permPathsRequired: 'Enter at least one path (collection, directory prefix or file).',
          permExpiry: 'Expires',
          permExpireNever: 'Never',
          permExpire30: '30 minutes',
          permExpire60: '1 hour',
          permExpire1440: '24 hours',
          permExpire10080: '7 days',
          permExpireUntil: 'Expires',
          permExpireExpired: 'Expired',
          permGrantSession: 'Grant current session',
          permGrantWorkspace: 'Grant current workspace',
          permAddDeny: 'Add global deny',
          permDelete: 'Delete',
          permLoading: 'Loading access information…',
          permRetry: 'Retry',
          permLoadFailed: 'Could not load access information: ',
          permNoSession: 'No session context; session permissions cannot be loaded.',
          permPolicyError: 'Policy file problem: ',
          permSaved: 'Policy saved.',
          permRuleAdded: 'Rule added.',
          permRuleDeleted: 'Rule deleted.',
          permDefaultSaved: 'Default saved.',
          permDenyAdded: 'Deny rule added.',
          permValidationFailed: 'Policy validation failed:',
          permCollections: 'Quick fill',
          permAccessFile: 'Policy file',
          permBackupHint: 'The previous policy is backed up under DSH_HOME/backups/ before saving.',
          permEffectHint: 'Changes apply to the next tool call; the prompt refreshes within 15 seconds.',
          permBusy: 'Saving…',
          importTitle: 'Import corpus',
          importDesc: 'Import documents into the corpus: extract text → optional AI structuring → write into a collection → rebuild the index.',
          importSource: 'Source',
          importModeFiles: 'Browser files',
          importModePath: 'Local path',
          importChooseFiles: 'Choose files (multiple)',
          importFilesHint: 'You can select multiple files; they are imported as one batch into the same collection. Each file must stay under the size limit; large files are better imported by local path.',
          importNoFiles: 'No files selected yet.',
          importRemoveFile: 'Remove',
          importReading: 'Reading files…',
          importFilesAdded: (count) => `Added ${count} file(s); they will be imported into one collection.`,
          importUnsupported: 'Unsupported format: ',
          importTooLarge: 'File exceeds the size limit: ',
          importTooMany: 'Too many files (limit: ',
          importReadFailed: 'Could not read file: ',
          importPathLabel: 'Local paths (one per line)',
          importPathPlaceholder: 'C:\\docs\\manual.pdf\nC:\\docs\\handbook\\\nC:\\docs\\appendix.pdf',
          importPathHint: 'One file or directory per line; directories are scanned recursively. All paths are imported into the same collection.',
          importPathRequired: 'Enter at least one local path (file or directory, one per line).',
          importTarget: 'Target',
          importCollection: 'Target collection',
          importPickCollection: 'Pick or type a collection name',
          importNoCollections: 'The corpus root has no collections yet; type a new name above and it will be created on import.',
          importNewCollectionHint: 'Type a new collection name to create it under the corpus root on import (letters/digits/._-, max 64 chars). Model access still needs a grant in the right sidebar.',
          importAutoCollectionHint: 'Leave empty to auto-create an import-<date>-<time> collection; all batch files go into it.',
          importNeedCollection: 'Choose or type a target collection.',
          settingsTitle: 'Corpus root',
          settingsDesc: 'Collections, indexes, originals and thumbnails all live here; you can move the whole corpus to a new location.',
          settingsCurrent: 'Current root',
          settingsCopy: 'Copy path',
          settingsCopied: 'Path copied.',
          settingsOpen: 'Open in Explorer',
          settingsChange: 'Change location',
          settingsClose: 'Collapse settings',
          settingsNewPath: 'New root (absolute path)',
          settingsNewPlaceholder: 'e.g. D:\\MyCorpus or C:\\Users\\you\\Documents\\corpus',
          settingsMigrate: 'Migrate corpus',
          settingsConfirm: 'Click again to confirm: all collections, indexes and originals will be moved.',
          settingsMigrating: 'Migrating…',
          settingsDone: 'Migration complete.',
          settingsRestart: 'Data was copied to the new location; restart DSH to use it (the old directory is kept for now).',
          settingsError: 'Migration failed: ',
          settingsBusy: 'An import/reindex task is running; wait for it to finish before migrating.',
          settingsNeedPath: 'Enter an absolute path for the new root first.',
          settingsOpenFailed: 'Could not open folder: ',
          settingsLoadError: 'Could not load root settings: ',
          settingsStateFile: 'Settings file',
          importPrefix: 'Prefix (optional)',
          importPrefixPlaceholder: 'e.g. guides/',
          importOptions: 'Options',
          importAiTitle: 'AI structuring',
          importAiHint: 'Uses the default model; runtime grows with document length.',
          importAiUnavailable: 'AI unavailable (no default model); falling back to deterministic Markdown.',
          importStart: 'Start import',
          importRunning: 'Importing…',
          importBusy: 'An import job is already running; wait for it to finish.',
          importStarted: 'Import job started; progress refreshes every second.',
          importProgress: 'Import progress',
          importStage: 'Stage',
          importStageExtract: 'Extract text',
          importStageAgent: 'AI structuring',
          importStageWrite: 'Write files',
          importStageIndex: 'Build index',
          importStageError: 'error',
          importCurrent: 'Current file',
          importCounts: 'Progress',
          importSucceeded: 'ok',
          importFailed: 'failed',
          importDone: 'Import finished.',
          importJobError: 'Import failed: ',
          importResult: 'Import result',
          importReindex: 'Rebuild job',
          importPollFailed: 'Could not poll import status: ',
          importTargetsLoading: 'Loading import targets…',
          importTargetsFailed: 'Could not load import targets: ',
          importFormatsTitle: 'Supported formats',
          importExtractorsTitle: 'Document extractors',
          importAvailable: 'available',
          importMissing: 'missing',
          importPdfHint: 'PDF text extraction unavailable: the bundled pdftotext is Windows x64 only; set CORPUS_PDFTOTEXT to an external pdftotext.',
          importPdfOcrHint: 'Scanned PDFs automatically use the bundled Windows OCR; image files go to the built-in ingest agent for image understanding.',
          importOfficeHint: 'DOCX/XLSX/PPTX use the bundled officecli first, falling back to the bundled pure-JS parser; no external install is required.',
          importOcrHint: 'Windows OCR is unavailable on this system: scanned PDFs may produce empty text.',
          importVisionHint: 'The current model/runtime does not accept images: image files fall back to bundled Windows OCR when available. In DSH Settings → Models → model options → Input types, enable “Image” and save; or set ingestVisionProvider/ingestVisionModel.',
          importVisionReason: 'Reason: ',
          importLimitHint: (size, count) => `Max ${size} per file, up to ${count} files; large files are better imported by local path.`,
          importErrorNote: 'Failed: ',
          importOpen: 'Import corpus',
          importClose: 'Collapse import',
          galleryTitle: 'Corpus files',
          galleryDesc: 'Files grouped by collection; icons use Windows thumbnails when available, and known extensions map to their TXT/MD/PDF file-type icons. Click a row to open the extracted text.',
          galleryFilter: 'Collection',
          galleryAll: 'All collections',
          galleryCount: (total, shown) => `${total} documents, showing ${shown}`,
          galleryName: 'Name',
          galleryType: 'Type',
          galleryAction: 'Action',
          galleryDocsUnit: 'docs',
          galleryExpandAll: 'Expand all',
          galleryCollapseAll: 'Collapse all',
          galleryExpandHint: 'Click a collection name to expand/collapse; use Delete at the end of a row to remove one document.',
          galleryCollapsed: 'collapsed',
          deleteRow: 'Delete',
          deleteRowConfirm: 'Confirm',
          galleryOpen: 'Open document',
          galleryProcessed: 'Processed (default)',
          galleryOriginal: 'Original file',
          galleryOriginalMissing: 'No original file',
          galleryDefaultOpen: 'Open with default app',
          galleryChooseWith: 'Open with…',
          galleryNoDocs: 'No corpus documents yet. Import files or call corpus_structure in the main session, then files will appear here.',
          reindexHelpTitle: 'Rebuild button help',
          reindexHelpIntro: 'Both buttons rebuild indexes for collections you can access, with different costs:',
          reindexHelpIncremental: 'Rebuild all (incremental): scans every collection and re-indexes only new/modified/removed documents, keeping chunks for unchanged files. Use this for daily updates; it is fast.',
          reindexHelpForce: 'Full rebuild all: drops existing indexes, re-chunks and rebuilds every document in all collections. Use after index corruption, chunking changes, or large rewrites; it is slow.',
          reindexHelpClose: 'Got it',
          deleteDoc: 'Delete this document',
          deleteDocConfirm: 'Confirm delete (move to trash)',
          deleteCollection: 'Delete collection',
          deleteCollectionConfirm: 'Confirm delete collection (move to trash)',
          deleteDone: 'Deleted; content moved to .corpus/trash and can be restored there.',
          deleteCollectionDone: 'Collection deleted and moved to .corpus/trash/collections.',
          deleteFailed: 'Delete failed: ',
          trashHint: 'Deletion is soft: content moves to .corpus/trash/<time>/ under the corpus root and can be restored manually.',
          galleryRefresh: 'Refresh corpus',
          galleryLoading: 'Loading corpus…',
          galleryError: 'Could not load corpus: ',
          galleryEmpty: 'No originals yet. Use Import corpus above to add images or documents.',
          galleryViewProcessed: 'View extracted text',
          galleryClose: 'Close',
          galleryAi: 'AI structured',
          galleryOriginal: 'Original',
          galleryCollection: 'Collection',
          gallerySize: 'Size',
          galleryImported: 'Imported',
          noCollections: 'No collections under the corpus root.',
          foot: 'Search and reads happen server-side; the panel only shows content inside the corpus root.',
        },
      }

      /** 按宿主页面的 lang / 浏览器语言选文案。 */
      function copy() {
        try {
          const declared = String(document.documentElement.getAttribute('lang') || navigator.language || '')
          return declared.toLowerCase().indexOf('zh') === 0 ? COPY.zh : COPY.en
        } catch {
          return COPY.zh
        }
      }

      function errorText(error) {
        return String(error && error.message ? error.message : error)
      }

      /** 请求错误：保留宿主返回的 errors[]（策略 400 校验用）。 */
      function requestFailure(message, body, status) {
        const error = new Error(message)
        error.errors = body !== null && body !== undefined && Array.isArray(body.errors)
          ? body.errors.map((item) => String(item))
          : []
        error.status = Number(status) || 0
        return error
      }

      /**
       * 统一请求：非 2xx 或（默认）body.ok !== true 都抛错，调用方负责把错误显示出来。
       * flags.allowFalse=true 时允许 {ok:false,...} 通过（重建的 busy/locked 需要读 job 信息）。
       */
      async function request(path, options, flags) {
        const tr = copy()
        let response
        try {
          response = await fetch(path, options || {})
        } catch (error) {
          throw new Error(tr.networkFailed + errorText(error))
        }
        let body = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (!response.ok) {
          const detail = body !== null && typeof body.error === 'string' ? body.error : 'HTTP ' + String(response.status)
          throw requestFailure(detail, body, response.status)
        }
        if (body === null) throw requestFailure('HTTP ' + String(response.status), null, response.status)
        const allowFalse = flags !== undefined && flags.allowFalse === true
        if (body.ok !== true && !allowFalse) {
          const detail = typeof body.error === 'string' && body.error !== '' ? body.error : 'HTTP ' + String(response.status)
          throw requestFailure(detail, body, response.status)
        }
        return body
      }

      function getJson(path) {
        return request(path, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
      }

      function postJson(path, payload, flags) {
        return request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload || {}),
        }, flags)
      }

      function num(value) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : 0
      }

      function formatSize(bytes) {
        const value = num(bytes)
        if (value <= 0) return '0 KB'
        if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + ' KB'
        return (value / 1024 / 1024).toFixed(1) + ' MB'
      }

      function formatTime(value) {
        if (!value) return '—'
        try {
          const date = new Date(value)
          if (Number.isNaN(date.getTime())) return String(value)
          const pad = (n) => String(n).padStart(2, '0')
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        } catch {
          return String(value)
        }
      }

      /** 命中片段的首行（hit.lines 形如 "45-51"）；解析失败回退 1。 */
      function firstLineOf(value) {
        const match = /^\s*(\d+)/.exec(String(value || ''))
        if (match === null) return 1
        const line = Number(match[1])
        return Number.isFinite(line) && line > 0 ? line : 1
      }

      /** 预览文本：宿主 readFile 已带行号；若将来返回纯文本，这里补上行号。 */
      function numberedText(data) {
        const raw = String(data && data.text ? data.text : '')
        if (raw === '') return ''
        const lines = raw.split(/\r?\n/)
        if (lines.length > 0 && /^\s*\d+\|/.test(lines[0])) return raw
        const from = Math.max(1, num(data && data.from) || 1)
        return lines.map((line, index) => String(from + index).padStart(6) + '| ' + line).join('\n')
      }

      /** 工作区视角下拉的候选：policy.grants 里出现过的 workspace。 */
      function workspaceOptionsOf(policy) {
        const seen = []
        if (!policy || !Array.isArray(policy.grants)) return seen
        for (const rule of policy.grants) {
          if (!rule || typeof rule.workspace !== 'string') continue
          const value = rule.workspace.trim()
          if (value === '' || seen.indexOf(value) !== -1) continue
          seen.push(value)
        }
        return seen
      }

      function jobStateText(t, job) {
        if (!job) return '—'
        if (job.state === 'error') return t.jobStateError
        if (job.state === 'running') return t.jobRunning
        return t.jobStateDone
      }

      /** yyyy-mm-dd hh:mm（规则有效期展示）。 */
      function formatMinute(value) {
        if (!value) return '—'
        try {
          const date = new Date(value)
          if (Number.isNaN(date.getTime())) return String(value)
          const pad = (n) => String(n).padStart(2, '0')
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
        } catch {
          return String(value)
        }
      }

      /** 规则的 expiresAt（number 或可解析 ISO）；没有则 null。 */
      function ruleExpiresAt(rule) {
        const raw = rule && rule.expiresAt !== undefined && rule.expiresAt !== null ? rule.expiresAt : null
        if (raw === null) return null
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw
        const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN
        return Number.isFinite(parsed) ? parsed : null
      }

      function ruleExpired(rule) {
        const at = ruleExpiresAt(rule)
        return at !== null && at <= Date.now()
      }

      function expiryText(t, rule) {
        const at = ruleExpiresAt(rule)
        if (at === null) return t.permExpireNever
        if (at <= Date.now()) return t.permExpireExpired
        return t.permExpireUntil + ' ' + formatMinute(at)
      }

      /** paths 输入：逗号（中英文）/顿号/换行分隔，去重。 */
      function parsePaths(text) {
        const seen = []
        for (const piece of String(text || '').split(/[\n,，、]+/)) {
          const value = piece.trim()
          if (value === '' || seen.indexOf(value) !== -1) continue
          seen.push(value)
        }
        return seen
      }

      function formatPaths(paths) {
        return Array.isArray(paths) && paths.length > 0 ? paths.map((item) => String(item)).join(', ') : ''
      }

      function appendPath(draft, value) {
        const current = String(draft || '').replace(/[\s,，、]+$/, '')
        return current === '' ? value : current + ', ' + value
      }

      function workspaceKeyOf(value) {
        return String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase()
      }

      function sameWorkspace(left, right) {
        const a = workspaceKeyOf(left)
        const b = workspaceKeyOf(right)
        return a !== '' && a === b
      }

      function sameRule(left, right) {
        if (!left || !right) return false
        if (String(left.workspace || '') !== String(right.workspace || '')) return false
        if (String(left.session || '') !== String(right.session || '')) return false
        const leftPaths = Array.isArray(left.paths) ? left.paths.map((item) => String(item)) : []
        const rightPaths = Array.isArray(right.paths) ? right.paths.map((item) => String(item)) : []
        if (leftPaths.join('\n') !== rightPaths.join('\n')) return false
        return ruleExpiresAt(left) === ruleExpiresAt(right)
      }

      function cloneRule(rule) {
        const next = { ...(rule && typeof rule === 'object' ? rule : {}) }
        if (Array.isArray(next.paths)) next.paths = next.paths.map((item) => String(item))
        return next
      }

      /** policySummary → 可提交的 policy（version/default/grants/deny）。 */
      function policyFromSummary(summary) {
        return {
          version: 1,
          default: summary && summary.default === 'allow' ? 'allow' : 'deny',
          grants: summary && Array.isArray(summary.grants) ? summary.grants.map(cloneRule) : [],
          deny: summary && Array.isArray(summary.deny) ? summary.deny.map(cloneRule) : [],
        }
      }

      function expiryOptions(t) {
        return [
          { value: '0', label: t.permExpireNever },
          { value: '30', label: t.permExpire30 },
          { value: '60', label: t.permExpire60 },
          { value: '1440', label: t.permExpire1440 },
          { value: '10080', label: t.permExpire10080 },
        ]
      }

      function expiryToExpiresAt(value) {
        const minutes = Number(value)
        if (!Number.isFinite(minutes) || minutes <= 0) return null
        return Date.now() + minutes * 60000
      }

      function shortId(value) {
        const text = String(value || '')
        return text.length > 14 ? text.slice(0, 12) + '…' : text
      }

      function subjectLabel(t, rule) {
        if (rule && typeof rule.workspace === 'string' && rule.workspace !== '') return t.policySubjectWorkspace + ': ' + rule.workspace
        if (rule && typeof rule.session === 'string' && rule.session !== '') return t.policySubjectSession + ': ' + rule.session
        return t.policyGlobal
      }

      // ---- v1.3 导入辅助 ----

      /** 统一比较扩展名与 /import/targets.formats（宿主可能给 'pdf' 或 '.pdf'）。 */
      function normalizeFormat(value) {
        const text = String(value || '').trim().toLowerCase()
        if (text === '') return ''
        return text.charAt(0) === '.' ? text : '.' + text
      }

      function extensionOf(name) {
        const text = String(name || '')
        const index = text.lastIndexOf('.')
        return index === -1 ? '' : text.slice(index).toLowerCase()
      }

      /** FileReader → 去掉 data URL 前缀，只留 base64（POST /import 的 files[].dataBase64）。 */
      function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
          const Reader = typeof FileReader !== 'undefined' ? FileReader : null
          if (Reader === null || typeof Reader !== 'function') {
            reject(new Error('FileReader is unavailable'))
            return
          }
          const reader = new Reader()
          reader.onload = () => {
            const raw = String(reader.result === null || reader.result === undefined ? '' : reader.result)
            const comma = raw.indexOf(',')
            resolve(comma === -1 ? raw : raw.slice(comma + 1))
          }
          reader.onerror = () => reject(reader.error || new Error('read error'))
          reader.readAsDataURL(file)
        })
      }

      /** 导入任务的结果对象（宿主可能放在 job.result / job 本身）。 */
      function importResultOf(job) {
        return job && job.result && typeof job.result === 'object' ? job.result : {}
      }

      function importReindexJobId(job) {
        const result = importResultOf(job)
        let value = result.reindexJobId
        if (value === undefined || value === null) value = job && job.reindexJobId
        if (value === undefined || value === null) {
          value = result.reindexJob && result.reindexJob.id !== undefined ? result.reindexJob.id : null
        }
        return value === null || value === undefined || String(value) === '' ? null : String(value)
      }

      function importStageLabel(t, stage) {
        const key = String(stage || '')
        if (key === 'extract') return t.importStageExtract
        if (key === 'agent') return t.importStageAgent
        if (key === 'write') return t.importStageWrite
        if (key === 'index') return t.importStageIndex
        if (key === 'error') return t.importStageError
        return key === '' ? '—' : key
      }

      /** 单个 item 的告警文本（宿主可能给 error 或 warnings[]）。 */
      function importItemWarning(item) {
        if (!item || typeof item !== 'object') return ''
        if (Array.isArray(item.warnings) && item.warnings.length > 0) {
          return item.warnings.map((value) => String(value)).filter((value) => value !== '').join('；')
        }
        if (typeof item.warning === 'string' && item.warning !== '') return item.warning
        return ''
      }

      function importItemProblem(item) {
        if (!item || typeof item !== 'object') return ''
        if (typeof item.error === 'string' && item.error !== '') return item.error
        const warning = importItemWarning(item)
        if (warning !== '') return warning
        return item.ok === false ? '—' : ''
      }

      /** 完成提示：成功/失败计数 + reindexJobId（失败时显示 job.error）。 */
      function importResultText(t, job) {
        if (!job || typeof job !== 'object') return t.importDone
        const result = importResultOf(job)
        if (job.state === 'error') return t.importJobError + String(job.error || result.error || '')
        const total = num(result.total !== undefined ? result.total : job.total)
        const written = num(result.written !== undefined
          ? result.written
          : result.imported !== undefined
            ? result.imported
            : result.done !== undefined ? result.done : job.done)
        const failed = num(result.failed !== undefined ? result.failed : job.failed)
        const parts = [t.importDone, t.importSucceeded + ' ' + String(written) + '/' + String(total), t.importFailed + ' ' + String(failed)]
        const reindexJobId = importReindexJobId(job)
        if (reindexJobId !== null) parts.push(t.importReindex + ' ' + reindexJobId)
        return parts.join(' · ')
      }

      // 主区域「在右侧栏编辑权限」的入口；apply 时按 sidebarRight 服务是否可用决定。
      let permissionsOpenTab = null
      let previewOpenTab = null

      // ---- 样式：全部用 DSH 设计 token，跟随主题 ----
      const PAGE = { height: '100%', overflowY: 'auto', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' }
      const INNER = { maxWidth: '1100px', margin: '0 auto', padding: '28px clamp(20px, 4vw, 44px) 48px', boxSizing: 'border-box' }
      const HEADER = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginBottom: '6px' }
      const H1 = { margin: '0 auto 0 0', fontSize: '20px', lineHeight: '28px', fontWeight: 500 }
      const DESC = { margin: '0 0 14px', fontSize: '13px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' }
      const BTN = {
        font: 'inherit', fontSize: '13px', lineHeight: '18px', padding: '5px 12px',
        borderRadius: 'var(--dsw-radius-md)', border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
      }
      const BTN_PRIMARY = { ...BTN, border: '1px solid transparent', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' }
      const BTN_GHOST = { ...BTN, border: '1px solid transparent', background: 'transparent', color: 'var(--dsw-alias-label-secondary)' }
      const INPUT = {
        font: 'inherit', fontSize: '13px', lineHeight: '20px', padding: '4px 10px', boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', outline: 'none',
      }
      const SELECT = { ...INPUT, cursor: 'pointer', maxWidth: '100%' }
      const SEARCH_ROW = { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }
      const CARD = {
        padding: '10px 14px', marginBottom: '8px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      }
      const HIT_CARD = {
        ...CARD, display: 'block', width: '100%', boxSizing: 'border-box',
        textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer',
      }
      const CHIPS = { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '0 0 18px' }
      const CHIP = {
        padding: '0 6px', fontSize: '11px', lineHeight: '17px', borderRadius: '999px',
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
      }
      const SMALL = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
      const STATUS = (ok) => ({ ...SMALL, margin: '0 0 12px', color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' })
      const FOOT = { ...SMALL, marginTop: '16px', color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' }
      const GRID = { display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'flex-start' }
      const COLUMN = { flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '20px' }
      const SECTION = {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)', padding: '14px 16px',
      }
      const H2 = { margin: '0 0 10px', fontSize: '14px', lineHeight: '20px', fontWeight: 600 }
      const ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }
      const PRE = {
        margin: '0', padding: '10px 12px', maxHeight: '460px', overflow: 'auto',
        fontSize: '12px', lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px', color: 'var(--dsw-alias-label-primary)',
      }
      // ---- 右栏「语料权限」：窄栏紧凑样式（宽度有限，全部用 token） ----
      const PERM_PAGE = {
        height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: '12px',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '12px', lineHeight: '18px',
      }
      const PERM_STACK = { display: 'flex', flexDirection: 'column', gap: '10px' }
      const PERM_SECTION = {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)', padding: '10px',
      }
      const PERM_HEAD = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', margin: '0 0 8px' }
      const PERM_H2 = { margin: '0 auto 0 0', fontSize: '13px', lineHeight: '18px', fontWeight: 600 }
      const PERM_LABEL = { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' }
      const PERM_TEXT = { ...SMALL, margin: '6px 0 0', wordBreak: 'break-all' }
      const PERM_TEXTAREA = {
        ...INPUT, width: '100%', minHeight: '52px', resize: 'vertical', boxSizing: 'border-box',
        font: 'inherit', fontSize: '12px', lineHeight: '18px',
      }
      const PERM_SELECT = { ...INPUT, width: 'auto', maxWidth: '100%', fontSize: '12px', padding: '3px 6px', cursor: 'pointer' }
      const PERM_FORM_ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginTop: '6px' }
      const PERM_RULE = {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', padding: '6px 8px', marginTop: '6px',
      }
      const PERM_RULE_TOP = { display: 'flex', alignItems: 'flex-start', gap: '6px' }
      const PERM_RULE_PATHS = { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-all', fontSize: '12px', lineHeight: '17px' }
      const PERM_RULE_META = { display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: '3px', fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' }
      const PERM_DELETE = { ...BTN_GHOST, fontSize: '11px', lineHeight: '16px', padding: '1px 6px', flex: '0 0 auto', color: 'var(--dsw-alias-state-error-primary)' }
      const PERM_CHIPS_ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', marginTop: '6px' }
      const PERM_CHIP_BTN = { ...BTN, fontSize: '11px', lineHeight: '16px', padding: '0 6px', borderRadius: '999px' }
      const PERM_SUMMARY = { cursor: 'pointer', fontSize: '13px', lineHeight: '18px', fontWeight: 600 }
      const PERM_NOTICE = {
        position: 'sticky', top: 0, zIndex: 2, display: 'flex', flexDirection: 'column', gap: '4px',
        background: 'var(--dsw-alias-bg-base)', padding: '2px 0',
      }
      const PERM_FOOT = { ...SMALL, margin: '8px 0 0', wordBreak: 'break-all', color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' }
      const PERM_LIST = { margin: '4px 0 0', padding: '0 0 0 16px', fontSize: '11px', lineHeight: '16px' }
      // v1.3 导入面板：进度条（窄栏，纯 token）
      const PERM_PROGRESS_TRACK = {
        height: '6px', marginTop: '6px', borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden',
      }
      const PERM_PROGRESS_FILL = {
        height: '100%', borderRadius: '999px',
        background: 'var(--dsw-alias-button-primary-fill)', transition: 'width 200ms ease',
      }
      const PERM_FILE_INPUT = { ...INPUT, width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '4px 6px' }

      /** 左侧栏图标：size/active 由 sidebar.panellist 传入（书本/层叠）。 */
      function CorpusIcon(props) {
        const size = props && Number(props.size) ? Number(props.size) : 16
        const active = props && props.active === true
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
          h('path', { d: 'M12 3 3 7.5l9 4.5 9-4.5L12 3Z' }),
          h('path', { d: 'M3 12l9 4.5 9-4.5' }),
          h('path', { d: 'M3 16.5 12 21l9-4.5' }),
        )
      }

      /** 盾牌（钥匙孔）图标：右栏 tab 与开始菜单 guide 条目共用。 */
      function ShieldIcon(props) {
        const size = props && Number(props.size) ? Number(props.size) : 16
        const active = props && props.active === true
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
          h('path', { d: 'M12 3 5 6v5.2c0 4.3 2.9 7.9 7 9.8 4.1-1.9 7-5.5 7-9.8V6l-7-3Z' }),
          h('circle', { cx: 12, cy: 10.2, r: 1.8 }),
          h('path', { d: 'M12 12v4.2' }),
        )
      }

      /** 上传/文档图标：右栏「语料导入」tab 与 guide 条目共用。 */
      function UploadIcon(props) {
        const size = props && Number(props.size) ? Number(props.size) : 16
        const active = props && props.active === true
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
          h('path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z' }),
          h('path', { d: 'M14 3v5h5' }),
          h('path', { d: 'M12 12v6' }),
          h('path', { d: 'm9.5 14.5 2.5-2.5 2.5 2.5' }),
        )
      }

      /** 策略规则列表（只读）。 */
      function RuleList(t, rules, emptyText) {
        if (!Array.isArray(rules) || rules.length === 0) return h('p', { style: SMALL }, emptyText)
        return h('div', null, rules.map((rule, index) => {
          const workspace = rule && typeof rule.workspace === 'string' ? rule.workspace : ''
          const session = rule && typeof rule.session === 'string' ? rule.session : ''
          const subject = workspace !== ''
            ? t.policySubjectWorkspace + ': ' + workspace
            : session !== ''
              ? t.policySubjectSession + ': ' + session
              : t.policyGlobal
          const paths = rule && Array.isArray(rule.paths)
            ? rule.paths.map((item) => String(item))
            : rule && typeof rule.path === 'string' ? [rule.path] : []
          return h('div', { key: 'rule-' + index, style: { ...SMALL, marginTop: '4px', wordBreak: 'break-all' } },
            h('span', null, subject + ' → ' + (paths.length > 0 ? paths.join(', ') : '—')),
          )
        }))
      }

      /** 原件缩略图卡片：仿资源管理器缩略图（延迟加载、等比裁切、失败回退）。 */
      function OriginalThumb(props) {
        const item = props.item
        const t = copy()
        const [broken, setBroken] = React.useState(false)
        const [mode, setMode] = React.useState('thumb')
        const src = mode === 'thumb'
          ? API.thumbnail + '?path=' + encodeURIComponent(item.original) + '&size=256&t=' + String(item.mtimeMs || 0)
          : API.original + '?path=' + encodeURIComponent(item.original) + '&t=' + String(item.mtimeMs || 0)
        const onError = () => {
          if (mode === 'thumb' && item.image) { setMode('original'); return }
          setBroken(true)
        }
        const thumb = !broken
          ? h('img', {
            src,
            alt: item.name,
            loading: 'lazy',
            decoding: 'async',
            style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            onError,
          })
          : h('div', {
            style: {
              width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', fontWeight: 600,
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          }, String(item.format || '?').toUpperCase())
        return h('button', {
          type: 'button',
          title: item.name,
          onClick: () => props.onOpen(item),
          style: {
            padding: 0, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', overflow: 'hidden',
            background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
            cursor: 'pointer', textAlign: 'left', font: 'inherit',
          },
        },
          h('div', {
            style: { aspectRatio: '1', background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
          }, thumb),
          h('div', { style: { padding: '6px 8px' } },
            h('div', { style: { fontSize: '12px', lineHeight: '17px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
            h('div', { style: { ...SMALL, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              item.collection + ' · ' + formatSize(item.bytes)),
            item.aiStructured ? h('span', { style: { ...CHIP, marginTop: '4px', display: 'inline-block' } }, t.galleryAi) : null,
          ),
        )
      }

      /** 主页面「原件库」：缩略图网格 + 大图/提取结果查看。 */
      function OriginalGallery() {
        const t = copy()
        const [data, setData] = React.useState({ loading: true, error: null, items: [], total: 0 })
        const [active, setActive] = React.useState(null)
        const [processed, setProcessed] = React.useState({ loading: false, error: null, data: null })

        const load = React.useCallback(() => {
          setData((prev) => ({ ...prev, loading: true, error: null }))
          getJson(API.originals).then((body) => {
            setData({
              loading: false,
              error: null,
              items: body && Array.isArray(body.imports) ? body.imports : [],
              total: body && typeof body.total === 'number' ? body.total : 0,
            })
          }).catch((error) => {
            setData({ loading: false, error: errorText(error), items: [], total: 0 })
          })
        }, [])

        React.useEffect(() => {
          load()
          const onChange = () => load()
          let target = null
          try { target = window } catch { target = null }
          if (target && typeof target.addEventListener === 'function') {
            target.addEventListener('dsh-corpus-originals-changed', onChange)
            return () => target.removeEventListener('dsh-corpus-originals-changed', onChange)
          }
          return undefined
        }, [load])

        const openItem = (item) => {
          setActive(item)
          setProcessed({ loading: false, error: null, data: null })
          if (item.processed) {
            setProcessed({ loading: true, error: null, data: null })
            postJson(API.read, { path: item.processed, from: 1, lines: 300 }).then((body) => {
              setProcessed({ loading: false, error: null, data: body })
            }).catch((error) => {
              setProcessed({ loading: false, error: errorText(error), data: null })
            })
          }
        }

        const originalUrl = (item) => API.original + '?path=' + encodeURIComponent(item.original) + '&t=' + String(item.mtimeMs || 0)

        let body
        if (data.loading) body = h('p', { style: SMALL }, t.galleryLoading)
        else if (data.error !== null) body = h('p', { role: 'status', style: STATUS(false) }, t.galleryError + data.error)
        else if (data.items.length === 0) body = h('p', { style: SMALL }, t.galleryEmpty)
        else {
          body = h('div', {
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' },
          }, data.items.map((item) => h(OriginalThumb, {
            key: item.collection + '/' + (item.folder || '') + '/' + item.name,
            item,
            onOpen: openItem,
          })))
        }

        const overlay = active === null ? null : h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0, 0, 0, 0.62)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          },
          onClick: () => setActive(null),
        },
          h('div', {
            style: {
              background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px',
              width: 'min(980px, 92vw)', maxHeight: '90vh', overflow: 'auto', padding: '16px', boxSizing: 'border-box',
            },
            onClick: (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation() },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' } },
              h('strong', { style: { wordBreak: 'break-all' } }, active.name),
              h('button', { type: 'button', style: BTN, onClick: () => setActive(null) }, t.galleryClose),
            ),
            active.image
              ? h('img', {
                src: originalUrl(active),
                alt: active.name,
                style: { maxWidth: '100%', maxHeight: '68vh', display: 'block', margin: '12px auto', objectFit: 'contain' },
              })
              : null,
            h('div', { style: { ...SMALL, marginTop: '8px' } },
              t.galleryCollection + ': ' + active.collection
              + ' · ' + t.gallerySize + ': ' + formatSize(active.bytes)
              + ' · ' + t.galleryImported + ': ' + formatTime(active.importedAt)),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' } },
              h('a', {
                href: originalUrl(active),
                target: '_blank',
                rel: 'noreferrer noopener',
                style: { ...BTN, textDecoration: 'none', display: 'inline-block' },
              }, t.galleryOpen),
              active.processed ? h('button', {
                type: 'button', style: BTN,
                onClick: () => {
                  if (processed.data !== null) { setProcessed({ loading: false, error: null, data: null }); return }
                  setProcessed({ loading: true, error: null, data: null })
                  postJson(API.read, { path: active.processed, from: 1, lines: 300 }).then((value) => {
                    setProcessed({ loading: false, error: null, data: value })
                  }).catch((error) => {
                    setProcessed({ loading: false, error: errorText(error), data: null })
                  })
                },
              }, t.galleryViewProcessed) : null,
            ),
            processed.loading ? h('p', { style: SMALL }, t.loading)
              : processed.error !== null ? h('p', { role: 'status', style: STATUS(false) }, t.failed + processed.error)
                : processed.data !== null ? h('pre', {
                  style: {
                    marginTop: '10px', padding: '10px', maxHeight: '30vh', overflow: 'auto',
                    background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px',
                    fontSize: '12px', lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  },
                }, processed.data.text) : null,
          ),
        )

        return h('section', { style: SECTION },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
            h('h2', { style: H2 }, t.galleryTitle),
            h('button', { type: 'button', style: BTN, onClick: load }, t.galleryRefresh),
          ),
          h('p', { style: SMALL }, t.galleryDesc),
          body,
          overlay,
        )
      }

      /** 主页面语料库根目录设置：查看/复制/打开/迁移。 */
      function CorpusRootSettings(props) {
        const t = copy()
        const [open, setOpen] = React.useState(false)
        const [info, setInfo] = React.useState({ loading: false, error: null, data: null })
        const [newRoot, setNewRoot] = React.useState('')
        const [armed, setArmed] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [note, setNote] = React.useState(null)
        const displayRoot = info.data !== null && typeof info.data.root === 'string' && info.data.root !== ''
          ? info.data.root
          : String(props && props.root ? props.root : '')

        const load = () => {
          setInfo((prev) => ({ ...prev, loading: true, error: null }))
          getJson(API.settings).then((body) => {
            setInfo({ loading: false, error: null, data: body })
          }).catch((error) => {
            setInfo({ loading: false, error: errorText(error), data: null })
          })
        }

        const toggle = () => {
          if (open) { setOpen(false); setArmed(false); return }
          setOpen(true)
          load()
        }

        const copyPath = () => {
          const value = displayRoot
          if (value === '') return
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(value).then(() => setNote({ ok: true, text: t.settingsCopied })).catch(() => {})
              return
            }
          } catch { /* fallback */ }
          setNote({ ok: false, text: value })
        }

        const openFolder = () => {
          postJson(API.settingsOpen, {}).then(() => {
            setNote({ ok: true, text: t.settingsOpen })
          }).catch((error) => {
            setNote({ ok: false, text: t.settingsOpenFailed + errorText(error) })
          })
        }

        const migrate = () => {
          if (busy) return
          const target = newRoot.trim()
          if (target === '') { setNote({ ok: false, text: t.settingsNeedPath }); return }
          if (!armed) { setArmed(true); setNote({ ok: true, text: t.settingsConfirm }); return }
          setBusy(true)
          setNote(null)
          postJson(API.settingsRoot, { root: target }).then((body) => {
            setBusy(false)
            setArmed(false)
            setNewRoot('')
            setInfo({ loading: false, error: null, data: body })
            setNote({
              ok: true,
              text: t.settingsDone + (body && body.restartRequired ? ' ' + t.settingsRestart : ''),
            })
            if (props && typeof props.onChanged === 'function') {
              try { props.onChanged() } catch { /* 刷新失败不影响迁移 */ }
            }
          }).catch((error) => {
            setBusy(false)
            setArmed(false)
            setNote({ ok: false, text: t.settingsError + errorText(error) })
          })
        }

        const currentLine = h('div', {
          style: {
            marginTop: '6px', padding: '8px 10px', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-2)', wordBreak: 'break-all',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px',
          },
        }, displayRoot === '' ? '—' : displayRoot)

        const buttons = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' } },
          h('button', { type: 'button', style: BTN, onClick: copyPath }, t.settingsCopy),
          h('button', { type: 'button', style: BTN, onClick: openFolder }, t.settingsOpen),
          h('button', { type: 'button', style: BTN, onClick: toggle }, open ? t.settingsClose : t.settingsChange),
        )

        const form = open
          ? h('div', { style: { marginTop: '10px' } },
            h('div', { style: PERM_LABEL }, t.settingsNewPath),
            h('input', {
              type: 'text',
              value: newRoot,
              placeholder: t.settingsNewPlaceholder,
              disabled: busy,
              style: { ...INPUT, width: '100%', boxSizing: 'border-box', marginTop: '4px', fontSize: '12px' },
              'aria-label': t.settingsNewPath,
              onChange: (event) => setNewRoot(event && event.target ? event.target.value : ''),
            }),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' } },
              h('button', {
                type: 'button',
                style: { ...BTN, opacity: busy ? 0.6 : 1 },
                disabled: busy,
                onClick: migrate,
              }, busy ? t.settingsMigrating : t.settingsMigrate),
            ),
            h('p', { style: PERM_TEXT }, t.settingsDesc),
            info.loading ? h('p', { style: PERM_TEXT }, t.loading) : null,
            info.error !== null ? h('p', { role: 'status', style: STATUS(false) }, t.settingsLoadError + info.error) : null,
            info.data && typeof info.data.stateFile === 'string'
              ? h('p', { style: { ...SMALL, wordBreak: 'break-all' } }, t.settingsStateFile + ': ' + info.data.stateFile)
              : null,
            info.data && info.data.busy === true
              ? h('p', { role: 'status', style: STATUS(false) }, t.settingsBusy)
              : null,
          )
          : null

        return h('section', { style: SECTION },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
            h('h2', { style: H2 }, t.settingsTitle),
          ),
          h('p', { style: SMALL }, t.settingsDesc),
          h('div', { style: { ...SMALL, marginTop: '6px' } }, t.settingsCurrent + ':'),
          currentLine,
          buttons,
          form,
          note !== null ? h('p', { role: 'status', style: STATUS(note.ok) }, note.text) : null,
        )
      }

      /** 增量/全量重建按钮旁的带圈问号说明。 */
      function ReindexHelp() {
        const t = copy()
        const [open, setOpen] = React.useState(false)
        return h('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
          h('button', {
            type: 'button',
            'aria-label': t.reindexHelpTitle,
            title: t.reindexHelpTitle,
            onClick: () => setOpen((value) => !value),
            style: {
              width: '22px', height: '22px', padding: 0, borderRadius: '50%', cursor: 'pointer',
              border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: '13px', fontWeight: 700,
              lineHeight: '20px', textAlign: 'center',
            },
          }, '?'),
          open ? h('div', {
            style: {
              position: 'absolute', top: '28px', right: 0, zIndex: 30, width: '330px', maxWidth: '80vw',
              padding: '12px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)', textAlign: 'left', fontSize: '12px', lineHeight: '18px',
            },
          },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, t.reindexHelpTitle),
            h('div', { style: { marginBottom: '8px' } }, t.reindexHelpIntro),
            h('div', { style: { marginBottom: '8px' } }, t.reindexHelpIncremental),
            h('div', { style: { marginBottom: '8px' } }, t.reindexHelpForce),
            h('button', { type: 'button', style: BTN, onClick: () => setOpen(false) }, t.reindexHelpClose),
          ) : null,
        )
      }

      const FILE_TYPE_ICONS = {
        pdf: { label: 'PDF', color: '#c62828' },
        doc: { label: 'DOC', color: '#1565c0' }, docx: { label: 'DOC', color: '#1565c0' }, odt: { label: 'DOC', color: '#1565c0' },
        xls: { label: 'XLS', color: '#2e7d32' }, xlsx: { label: 'XLS', color: '#2e7d32' }, ods: { label: 'XLS', color: '#2e7d32' },
        ppt: { label: 'PPT', color: '#c05600' }, pptx: { label: 'PPT', color: '#c05600' }, odp: { label: 'PPT', color: '#c05600' },
        txt: { label: 'TXT', color: '#546e7a' }, text: { label: 'TXT', color: '#546e7a' }, log: { label: 'LOG', color: '#546e7a' },
        md: { label: 'MD', color: '#37474f' }, markdown: { label: 'MD', color: '#37474f' }, mdx: { label: 'MD', color: '#37474f' },
        rst: { label: 'RST', color: '#455a64' }, adoc: { label: 'ADOC', color: '#455a64' }, tex: { label: 'TEX', color: '#455a64' },
        csv: { label: 'CSV', color: '#00695c' }, tsv: { label: 'CSV', color: '#00695c' },
        json: { label: 'JSON', color: '#5d4037' }, jsonc: { label: 'JSON', color: '#5d4037' }, json5: { label: 'JSON', color: '#5d4037' },
        yaml: { label: 'YML', color: '#6a1b9a' }, yml: { label: 'YML', color: '#6a1b9a' }, toml: { label: 'TOML', color: '#6a1b9a' },
        xml: { label: 'XML', color: '#455a64' }, html: { label: 'HTML', color: '#d84315' }, htm: { label: 'HTML', color: '#d84315' },
        css: { label: 'CSS', color: '#1565c0' }, scss: { label: 'CSS', color: '#1565c0' }, sass: { label: 'CSS', color: '#1565c0' }, less: { label: 'CSS', color: '#1565c0' },
        js: { label: 'JS', color: '#f9a825' }, mjs: { label: 'JS', color: '#f9a825' }, cjs: { label: 'JS', color: '#f9a825' }, jsx: { label: 'JSX', color: '#f9a825' },
        ts: { label: 'TS', color: '#1976d2' }, mts: { label: 'TS', color: '#1976d2' }, cts: { label: 'TS', color: '#1976d2' }, tsx: { label: 'TSX', color: '#1976d2' },
        py: { label: 'PY', color: '#1976d2' }, pyi: { label: 'PY', color: '#1976d2' },
        go: { label: 'GO', color: '#00acc1' }, rs: { label: 'RS', color: '#d35400' },
        java: { label: 'JAVA', color: '#c62828' }, kt: { label: 'KT', color: '#7b1fa2' }, kts: { label: 'KT', color: '#7b1fa2' }, scala: { label: 'SCALA', color: '#c62828' },
        c: { label: 'C', color: '#1565c0' }, h: { label: 'H', color: '#1565c0' }, cpp: { label: 'CPP', color: '#1565c0' }, cc: { label: 'CPP', color: '#1565c0' }, cxx: { label: 'CPP', color: '#1565c0' }, hpp: { label: 'CPP', color: '#1565c0' }, hh: { label: 'CPP', color: '#1565c0' },
        cs: { label: 'C#', color: '#512da8' }, rb: { label: 'RB', color: '#c62828' }, php: { label: 'PHP', color: '#6a1b9a' }, swift: { label: 'SWIFT', color: '#e65100' },
        sh: { label: 'SH', color: '#2e7d32' }, bash: { label: 'SH', color: '#2e7d32' }, zsh: { label: 'SH', color: '#2e7d32' }, fish: { label: 'SH', color: '#2e7d32' },
        ps1: { label: 'PS1', color: '#1976d2' }, bat: { label: 'BAT', color: '#546e7a' }, cmd: { label: 'BAT', color: '#546e7a' },
        lua: { label: 'LUA', color: '#1565c0' }, sql: { label: 'SQL', color: '#1565c0' }, vue: { label: 'VUE', color: '#2e7d32' },
        svelte: { label: 'SVELTE', color: '#e65100' }, astro: { label: 'ASTRO', color: '#e65100' },
        png: { label: 'IMG', color: '#ad1457' }, jpg: { label: 'IMG', color: '#ad1457' }, jpeg: { label: 'IMG', color: '#ad1457' }, webp: { label: 'IMG', color: '#ad1457' },
        gif: { label: 'IMG', color: '#ad1457' }, bmp: { label: 'IMG', color: '#ad1457' }, tif: { label: 'IMG', color: '#ad1457' }, tiff: { label: 'IMG', color: '#ad1457' },
        ico: { label: 'ICO', color: '#ad1457' }, svg: { label: 'SVG', color: '#ad1457' },
        zip: { label: 'ZIP', color: '#6d4c41' }, '7z': { label: '7Z', color: '#6d4c41' }, rar: { label: 'RAR', color: '#6d4c41' }, gz: { label: 'GZ', color: '#6d4c41' }, tar: { label: 'TAR', color: '#6d4c41' },
        mp3: { label: 'AUDIO', color: '#8e24aa' }, wav: { label: 'AUDIO', color: '#8e24aa' }, flac: { label: 'AUDIO', color: '#8e24aa' },
        mp4: { label: 'VIDEO', color: '#8e24aa' }, mkv: { label: 'VIDEO', color: '#8e24aa' }, mov: { label: 'VIDEO', color: '#8e24aa' },
        repository: { label: 'REPO', color: '#5e35b1' }, session: { label: 'CHAT', color: '#5e35b1' },
      }

      /** 文件类型图标：有 Windows 缩略图用缩略图，否则按已知扩展名显示对应文件图标。 */
      function FileTypeIcon(props) {
        const item = props.item
        const [broken, setBroken] = React.useState(false)
        if (item.thumbnail && !broken) {
          return h('img', {
            src: item.thumbnail,
            alt: '',
            loading: 'lazy',
            decoding: 'async',
            onError: () => setBroken(true),
            style: { width: '26px', height: '26px', objectFit: 'cover', borderRadius: '3px', display: 'block', border: '1px solid var(--dsw-alias-border-l2)' },
          })
        }
        const format = String(item.format || '').toLowerCase()
        const known = FILE_TYPE_ICONS[format] || null
        const label = known ? known.label : (format === '' ? 'TXT' : format.slice(0, 4).toUpperCase())
        const color = known ? known.color : '#607d8b'
        return h('div', {
          title: label,
          style: { position: 'relative', width: '26px', height: '28px', flex: '0 0 26px' },
        },
          h('div', {
            style: {
              position: 'absolute', inset: 0, borderRadius: '3px',
              border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
            },
          }),
          h('div', {
            style: {
              position: 'absolute', left: '2px', right: '2px', bottom: '2px', padding: '1px 0',
              borderRadius: '2px', background: color, color: '#fff', textAlign: 'center',
              fontSize: label.length > 3 ? '6px' : '7px', fontWeight: 700, lineHeight: '9px', letterSpacing: '0.2px',
            },
          }, label),
        )
      }

      /** 主页面「语料文件」：按集合分组的 Windows 资源管理器式列表。 */
      function CorpusGallery(props) {
        const t = copy()
        const collections = Array.isArray(props && props.collections) ? props.collections : []
        const [collection, setCollection] = React.useState('')
        const [data, setData] = React.useState({ loading: true, error: null, items: [], total: 0, shown: 0 })
        const [expanded, setExpanded] = React.useState({})
        const [menuPath, setMenuPath] = React.useState(null)

        const load = React.useCallback(() => {
          setData((prev) => ({ ...prev, loading: true, error: null }))
          const query = '?limit=1000' + (collection === '' ? '' : '&collection=' + encodeURIComponent(collection))
          getJson(API.gallery + query).then((body) => {
            setData({
              loading: false,
              error: null,
              items: body && Array.isArray(body.items) ? body.items : [],
              total: body && typeof body.total === 'number' ? body.total : 0,
              shown: body && Array.isArray(body.items) ? body.items.length : 0,
            })
          }).catch((error) => {
            setData({ loading: false, error: errorText(error), items: [], total: 0, shown: 0 })
          })
        }, [collection])

        React.useEffect(() => {
          load()
          const onChange = () => load()
          let target = null
          try { target = window } catch { target = null }
          if (target && typeof target.addEventListener === 'function') {
            target.addEventListener('dsh-corpus-originals-changed', onChange)
            return () => target.removeEventListener('dsh-corpus-originals-changed', onChange)
          }
          return undefined
        }, [load])

        const filter = h('select', {
          value: collection,
          disabled: data.loading,
          'aria-label': t.galleryFilter,
          style: { ...PERM_SELECT, fontSize: '12px' },
          onChange: (event) => {
            const value = event && event.target ? event.target.value : ''
            setCollection(value)
            if (value !== '') setExpanded((prev) => ({ ...prev, [value]: true }))
          },
        },
          h('option', { value: '' }, t.galleryAll),
          collections.map((item) => {
            const name = item && typeof item.name === 'string' ? item.name : ''
            return name === '' ? null : h('option', { key: 'gallery-' + name, value: name }, name)
          }).filter(Boolean),
        )

        const byCollection = new Map()
        for (const item of data.items) {
          const key = item.collection || ''
          if (!byCollection.has(key)) byCollection.set(key, [])
          byCollection.get(key).push(item)
        }
        const orderedNames = []
        for (const item of collections) {
          const name = item && typeof item.name === 'string' ? item.name : ''
          if (name !== '' && !orderedNames.includes(name)) orderedNames.push(name)
        }
        for (const name of byCollection.keys()) if (!orderedNames.includes(name)) orderedNames.push(name)
        const groups = orderedNames
          .map((name) => ({ name, items: byCollection.get(name) || [] }))
          .filter((group) => group.items.length > 0)
        const toggleGroup = (name) => setExpanded((prev) => ({ ...prev, [name]: !prev[name] }))

        const tableHead = h('div', {
          style: {
            display: 'grid', gridTemplateColumns: '34px minmax(160px, 1fr) 74px 82px 128px 174px',
            gap: '8px', alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)',
            color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', fontWeight: 600,
          },
        },
          h('span', null, ''),
          h('span', null, t.galleryName),
          h('span', null, t.galleryType),
          h('span', null, t.gallerySize),
          h('span', null, t.galleryImported),
          h('span', null, t.galleryAction),
        )

        const row = (item) => h('div', {
          key: item.path,
          role: 'row',
          title: item.path,
          onClick: () => { if (typeof props.onExternal === 'function') props.onExternal(item, 'default') },
          style: {
            display: 'grid', gridTemplateColumns: '34px minmax(160px, 1fr) 74px 82px 128px 174px',
            gap: '8px', alignItems: 'center', padding: '5px 8px', cursor: 'pointer',
            borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 45%, transparent)',
            fontSize: '12px', lineHeight: '18px',
          },
        },
          h('span', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } }, h(FileTypeIcon, { item })),
          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 } },
            item.title,
            item.aiStructured ? h('span', { style: { ...CHIP, marginLeft: '6px', fontSize: '10px', padding: '0 5px' } }, t.galleryAi) : null,
          ),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase' } }, String(item.format || 'text')),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, formatSize(item.bytes)),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, formatTime(item.importedAt)),
          h('span', {
            style: { position: 'relative', display: 'flex', gap: '4px', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'nowrap' },
            onClick: (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation() },
          },
            h('div', { style: { display: 'flex', alignItems: 'center' } },
              h('button', {
                type: 'button',
                style: { ...BTN, padding: '2px 7px', fontSize: '10px', borderTopRightRadius: 0, borderBottomRightRadius: 0 },
                title: t.externalOpen + '（' + t.galleryProcessed + '）',
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  setMenuPath(null)
                  if (typeof props.onExternal === 'function') props.onExternal(item, 'processed', 'choose')
                },
              }, '📂 ' + t.externalOpen),
              h('button', {
                type: 'button',
                style: { ...BTN, padding: '2px 5px', fontSize: '10px', borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
                title: t.galleryProcessed + ' / ' + t.galleryOriginal,
                'aria-label': t.galleryProcessed + ' / ' + t.galleryOriginal,
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  setMenuPath((prev) => prev === item.path ? null : item.path)
                },
              }, '▾'),
            ),
            menuPath === item.path ? h('div', {
              style: {
                position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 30,
                minWidth: '190px', padding: '5px', boxSizing: 'border-box',
                background: 'var(--dsw-alias-bg-layer-1)',
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
                boxShadow: '0 6px 18px rgba(0,0,0,0.28)',
              },
            },
              h('div', { style: { ...SMALL, padding: '2px 6px 5px', color: 'var(--dsw-alias-label-secondary)' } }, t.galleryChooseWith),
              h('button', {
                type: 'button',
                style: { ...BTN, display: 'block', width: '100%', textAlign: 'left', fontSize: '11px', marginBottom: '3px' },
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  setMenuPath(null)
                  if (typeof props.onExternal === 'function') props.onExternal(item, 'processed', 'choose')
                },
              }, t.galleryProcessed + '…'),
              h('button', {
                type: 'button',
                disabled: !item.original,
                style: {
                  ...BTN, display: 'block', width: '100%', textAlign: 'left', fontSize: '11px',
                  opacity: item.original ? 1 : 0.45, cursor: item.original ? 'pointer' : 'not-allowed',
                },
                title: item.original || t.galleryOriginalMissing,
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  if (!item.original) return
                  setMenuPath(null)
                  if (typeof props.onExternal === 'function') props.onExternal(item, 'original', 'choose')
                },
              }, item.original ? t.galleryOriginal + '…' : t.galleryOriginalMissing),
              h('div', { style: { height: '1px', margin: '5px 2px', background: 'var(--dsw-alias-border-l2)' } }),
              h('button', {
                type: 'button',
                style: { ...BTN, display: 'block', width: '100%', textAlign: 'left', fontSize: '11px' },
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  setMenuPath(null)
                  if (typeof props.onExternal === 'function') props.onExternal(item, 'processed', 'default')
                },
              }, t.galleryDefaultOpen),
            ) : null,
            h(DeleteButton, {
              key: 'delete-row',
              payload: { path: item.path },
              label: t.deleteRow,
              confirmLabel: t.deleteRowConfirm,
              onDeleted: () => {
                load()
                if (props && typeof props.onDeleted === 'function') props.onDeleted()
              },
            }),
          ),
        )

        let body
        if (data.loading) body = h('p', { style: SMALL }, t.galleryLoading)
        else if (data.error !== null) body = h('p', { role: 'status', style: STATUS(false) }, t.galleryError + data.error)
        else if (groups.length === 0) body = h('p', { style: SMALL }, t.galleryNoDocs)
        else {
          body = h('div', null,
            h('p', { style: { ...SMALL, marginBottom: '8px' } }, t.galleryCount(data.total, data.shown)),
            groups.map((group) => h('div', { key: 'group-' + group.name, style: { marginBottom: '12px' } },
              h('div', {
                role: 'button',
                'aria-expanded': expanded[group.name] === true,
                onClick: () => toggleGroup(group.name),
                style: {
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                  padding: '6px 8px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-l2)', marginBottom: expanded[group.name] === true ? '2px' : '0',
                  cursor: 'pointer', userSelect: 'none',
                },
              },
                h('strong', { style: { fontSize: '13px' } },
                  (expanded[group.name] === true ? '▾ ' : '▸ ') + group.name),
                h('span', { style: SMALL }, String(group.items.length) + ' ' + t.galleryDocsUnit
                  + (expanded[group.name] === true ? '' : ' · ' + t.galleryCollapsed)),
              ),
              expanded[group.name] === true
                ? h(React.Fragment, null, tableHead, h('div', { role: 'table' }, group.items.map(row)))
                : null,
            )),
          )
        }

        return h('section', { style: SECTION },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
            h('h2', { style: H2 }, t.galleryTitle),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              filter,
              h('button', {
                type: 'button', style: BTN,
                onClick: () => setExpanded(Object.fromEntries(groups.map((group) => [group.name, true]))),
              }, t.galleryExpandAll),
              h('button', { type: 'button', style: BTN, onClick: () => setExpanded({}) }, t.galleryCollapseAll),
              h('button', { type: 'button', style: BTN, onClick: load }, t.galleryRefresh),
            ),
          ),
          h('p', { style: SMALL }, t.galleryDesc),
          h('p', { style: SMALL }, t.galleryExpandHint),
          body,
        )
      }

      /** 两击确认的软删除按钮（文档/集合共用）。 */
      function DeleteButton(props) {
        const t = copy()
        const [armed, setArmed] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [note, setNote] = React.useState(null)
        const label = armed ? (props.confirmLabel || t.deleteDocConfirm) : (props.label || t.deleteDoc)
        const run = () => {
          if (busy) return
          if (!armed) { setArmed(true); return }
          setBusy(true)
          setNote(null)
          postJson(API.delete, props.payload).then((body) => {
            setBusy(false)
            setArmed(false)
            setNote({ ok: true, text: t.deleteDone })
            if (props.onDeleted) {
              try { props.onDeleted(body) } catch { /* 删除已完成 */ }
            }
          }).catch((error) => {
            setBusy(false)
            setArmed(false)
            setNote({ ok: false, text: t.deleteFailed + errorText(error) })
          })
        }
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            title: t.trashHint,
            disabled: busy,
            onClick: run,
            style: {
              ...BTN, fontSize: '12px', padding: '3px 9px',
              color: 'var(--dsw-alias-state-error-primary)',
              borderColor: 'var(--dsw-alias-state-error-primary)',
            },
          }, busy ? '…' : label),
          note !== null ? h('span', { role: 'status', style: { ...SMALL, color: note.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, note.text) : null,
        )
      }

      /** 主区域整页。 */
      function CorpusPage() {
        const t = copy()
        const [overview, setOverview] = React.useState({ loading: true, error: null, data: null })
        const [statusInfo, setStatusInfo] = React.useState({ active: null, recent: [], error: null })
        const [starting, setStarting] = React.useState(false)
        const [jobNote, setJobNote] = React.useState(null)
        const [pendingForce, setPendingForce] = React.useState(false)
        const [query, setQuery] = React.useState('')
        const [collectionFilter, setCollectionFilter] = React.useState('')
        const [workspaceFilter, setWorkspaceFilter] = React.useState('')
        const [searchState, setSearchState] = React.useState({ loading: false, error: null, data: null, ran: false, empty: false })
        const [previewState, setPreviewState] = React.useState({ loading: false, error: null, data: null, path: null })
        const [permissionsNote, setPermissionsNote] = React.useState(null)
        // v1.3：主页面「导入语料」区是否展开（新加在最后，保持前面 hook 下标不变）。
        const [importOpen, setImportOpen] = React.useState(false)
        const pollRef = React.useRef({ timer: null, generation: 0, hadActive: false })
        const mountedRef = React.useRef(true)

        const loadOverview = () => {
          setOverview((prev) => ({ ...prev, loading: true, error: null }))
          return getJson(API.overview).then((body) => {
            if (!mountedRef.current) return
            setOverview({ loading: false, error: null, data: body })
          }).catch((error) => {
            if (!mountedRef.current) return
            setOverview({ loading: false, error: errorText(error), data: null })
          })
        }

        const startPolling = () => {
          const gate = pollRef.current
          if (gate.timer !== null) return
          gate.generation += 1
          const generation = gate.generation
          const tick = () => {
            getJson(API.status).then((body) => {
              if (!mountedRef.current || gate.generation !== generation) return
              const tr = copy()
              const active = body.active ? body.active : null
              const recent = Array.isArray(body.recent) ? body.recent : []
              setStatusInfo({ active, recent, error: null })
              if (active !== null) {
                gate.hadActive = true
                gate.timer = setTimeout(tick, POLL_MS)
                return
              }
              gate.timer = null
              const wasActive = gate.hadActive
              gate.hadActive = false
              setStarting(false)
              if (wasActive) {
                const last = recent.length > 0 ? recent[0] : null
                const failed = Boolean(last && last.state === 'error')
                const text = last === null
                  ? tr.jobDone
                  : failed
                    ? tr.jobError + String(last.error || '')
                    : tr.jobDone + (num(last.ms) > 0 ? ' · ' + tr.jobUnit(num(last.ms)) : '')
                setJobNote({ ok: !failed, text })
                loadOverview()
              }
            }).catch((error) => {
              if (!mountedRef.current || gate.generation !== generation) return
              const tr = copy()
              gate.timer = null
              gate.hadActive = false
              setStarting(false)
              setStatusInfo((prev) => ({ ...prev, active: null, error: errorText(error) }))
              setJobNote({ ok: false, text: tr.pollFailed + errorText(error) })
            })
          }
          tick()
        }

        const loadStatus = () => getJson(API.status).then((body) => {
          if (!mountedRef.current) return
          const active = body.active ? body.active : null
          setStatusInfo({ active, recent: Array.isArray(body.recent) ? body.recent : [], error: null })
          if (active !== null) {
            pollRef.current.hadActive = true
            startPolling()
          }
        }).catch((error) => {
          if (!mountedRef.current) return
          setStatusInfo((prev) => ({ ...prev, error: errorText(error) }))
        })

        React.useEffect(() => {
          mountedRef.current = true
          loadOverview()
          loadStatus()
          return () => {
            mountedRef.current = false
            const gate = pollRef.current
            gate.generation += 1
            if (gate.timer !== null) {
              clearTimeout(gate.timer)
              gate.timer = null
            }
          }
        }, [])

        const reload = () => {
          setJobNote(null)
          setPendingForce(false)
          loadOverview()
          loadStatus()
        }

        /** 主区域策略区入口：在右侧栏打开「语料权限」。 */
        const openPermissions = () => {
          if (typeof permissionsOpenTab !== 'function') {
            setPermissionsNote({ ok: false, text: t.openPermissionsHint })
            return
          }
          try {
            permissionsOpenTab()
            setPermissionsNote({ ok: true, text: t.openPermissionsRequested })
          } catch (error) {
            setPermissionsNote({ ok: false, text: t.openPermissionsHint })
          }
        }

        const submitSearch = () => {
          const text = query.trim()
          if (text === '') {
            setSearchState({ loading: false, error: null, data: null, ran: true, empty: true })
            return
          }
          const payload = { query: text, limit: 20 }
          if (collectionFilter !== '') payload.collections = [collectionFilter]
          // 工作区选项里的 '*' 是“全部工作区”的语义（宿主 authorize 会把它当字面主体，不能直接传）。
          if (workspaceFilter !== '' && workspaceFilter !== '*') payload.workspace = workspaceFilter
          setSearchState({ loading: true, error: null, data: null, ran: true, empty: false })
          postJson(API.search, payload).then((body) => {
            if (!mountedRef.current) return
            setSearchState({ loading: false, error: null, data: body, ran: true, empty: false })
          }).catch((error) => {
            if (!mountedRef.current) return
            setSearchState({ loading: false, error: errorText(error), data: null, ran: true, empty: false })
          })
        }

        const openPreview = (path, from) => {
          const start = Math.max(1, num(from) || 1)
          publishPreview({ path, from: start })
          if (typeof previewOpenTab === 'function') {
            previewOpenTab()
          } else {
            // 没有右侧栏能力时退回外部查看器，避免“点了没反应”。
            postJson(API.openExternal, { path, mode: 'default' }).catch(() => {})
          }
        }

        const closePreview = () => setPreviewState({ loading: false, error: null, data: null, path: null })

        const openExternal = (path, mode) => {
          if (typeof path !== 'string' || path === '') return
          postJson(API.openExternal, { path, mode: mode === 'choose' ? 'choose' : 'default' }).catch(() => {})
        }

        const startReindex = (payload) => {
          const tr = copy()
          setStarting(true)
          setJobNote(null)
          setPendingForce(false)
          postJson(API.reindex, payload, { allowFalse: true }).then((body) => {
            if (!mountedRef.current) return
            if (body.ok !== true) {
              setStarting(false)
              setJobNote({ ok: false, text: tr.failed + String(body.error || '') })
              return
            }
            if (body.started === false) {
              const locked = body.locked && typeof body.locked === 'object' ? body.locked : null
              const pid = locked && Number.isFinite(Number(locked.pid)) ? Number(locked.pid) : null
              setStarting(false)
              setJobNote({ ok: false, text: locked !== null ? (pid === null ? tr.lockedUnknown : tr.locked(pid)) : tr.busy })
              if (body.job && typeof body.job === 'object') {
                setStatusInfo({ active: body.job, recent: [], error: null })
              }
              if (locked === null) {
                // 已有活动任务：它结束时也要刷新 overview、显示结果。
                pollRef.current.hadActive = true
                startPolling()
              }
              return
            }
            setStarting(false)
            setJobNote({ ok: true, text: tr.started })
            if (body.job && typeof body.job === 'object') {
              setStatusInfo({ active: body.job, recent: [], error: null })
            }
            // 任务可能极快结束（首个 status 轮询就看不到 active），先标上“曾经有任务”，
            // 保证结束时仍会提示结果并刷新 overview。
            pollRef.current.hadActive = true
            startPolling()
          }).catch((error) => {
            if (!mountedRef.current) return
            setStarting(false)
            setJobNote({ ok: false, text: tr.failed + errorText(error) })
          })
        }

        const active = statusInfo.active
        const busy = starting || active !== null
        const overviewData = overview.data
        const stats = overviewData && overviewData.stats ? overviewData.stats : null
        const collections = overviewData && Array.isArray(overviewData.collections) ? overviewData.collections : []
        const policy = overviewData && overviewData.policy && typeof overviewData.policy === 'object' ? overviewData.policy : null
        const collectionNames = collections.map((item) => String(item && item.name ? item.name : '')).filter((name) => name !== '')
        const workspaceOptions = workspaceOptionsOf(policy)
        const hits = searchState.data && Array.isArray(searchState.data.hits) ? searchState.data.hits : []
        const scope = searchState.data && searchState.data.scope && typeof searchState.data.scope === 'object' ? searchState.data.scope : null
        let scopeText = collectionFilter !== '' ? collectionFilter : t.allCollections
        if (scope && Array.isArray(scope.collections)) {
          scopeText = scope.collections.length > 0 ? scope.collections.join(', ') : '—'
        }
        const scopeWorkspace = scope && typeof scope.workspace === 'string' && scope.workspace !== '' ? scope.workspace : ''
        const previewData = previewState.data
        const goPrev = () => {
          if (!previewData) return
          openPreview(previewState.path, Math.max(1, num(previewData.from) - PAGE_LINES))
        }
        const goNext = () => {
          if (!previewData) return
          if (num(previewData.to) >= num(previewData.totalLines)) return
          openPreview(previewState.path, num(previewData.from) + PAGE_LINES)
        }
        const lastJob = statusInfo.recent.length > 0 ? statusInfo.recent[0] : null

        // ---- 顶部：标题 / 导入区开关 / 刷新 / 根 / 统计 ----
        const header = h('div', { style: HEADER },
          h('h1', { style: H1 }, t.title),
          h('button', {
            type: 'button',
            style: importOpen ? BTN_PRIMARY : BTN,
            onClick: () => setImportOpen(!importOpen),
          }, importOpen ? t.importClose : t.importOpen),
          h('button', { type: 'button', style: BTN, disabled: overview.loading, onClick: reload }, overview.loading ? t.loading : t.refresh),
        )

        const rootLine = overviewData
          ? h('div', { style: { ...SMALL, wordBreak: 'break-all', marginBottom: '10px' } }, t.root + ': ' + String(overviewData.root || ''))
          : null

        const statsRow = stats === null ? null : h('div', { style: CHIPS },
          [
            [t.statsCollections, num(stats.collections)],
            [t.statsDocs, num(stats.docs)],
            [t.statsChunks, num(stats.chunks)],
            [t.statsIndex, formatSize(stats.indexBytes)],
          ].map((item) => h('span', { key: 'stat-' + item[0], style: CHIP }, item[0] + ' ' + String(item[1]))),
        )

        const overviewError = overview.error !== null
          ? h('p', { role: 'status', style: STATUS(false) }, t.overviewFailed + overview.error)
          : null

        // ---- 检索区 ----
        const collectionSelect = h('select', {
          value: collectionFilter,
          style: SELECT,
          'aria-label': t.collectionLabel,
          onChange: (event) => setCollectionFilter(event && event.target ? event.target.value : ''),
        },
          h('option', { value: '' }, t.collectionLabel + ': ' + t.allCollections),
          collectionNames.map((name) => h('option', { key: 'collection-' + name, value: name }, name)),
        )

        const workspaceSelect = h('select', {
          value: workspaceFilter,
          style: SELECT,
          'aria-label': t.workspaceLabel,
          onChange: (event) => setWorkspaceFilter(event && event.target ? event.target.value : ''),
        },
          h('option', { value: '' }, t.workspaceLabel + ': ' + t.allCollections),
          workspaceOptions.map((value, index) => h('option', { key: 'workspace-' + index + '-' + value, value },
            value === '*' ? t.allWorkspaces : value)),
        )

        const searchSection = h('section', { style: SECTION },
          h('h2', { style: H2 }, t.searchTitle),
          h('div', { style: SEARCH_ROW },
            h('input', {
              type: 'search',
              value: query,
              placeholder: t.searchPlaceholder,
              style: { ...INPUT, flex: '1 1 220px', minWidth: '160px' },
              'aria-label': t.searchPlaceholder,
              onChange: (event) => setQuery(event && event.target ? event.target.value : ''),
              onKeyDown: (event) => { if (event && event.key === 'Enter') submitSearch() },
            }),
            collectionSelect,
            workspaceSelect,
            h('button', { type: 'button', style: BTN_PRIMARY, disabled: searchState.loading, onClick: submitSearch }, searchState.loading ? t.searching : t.search),
          ),
          searchState.empty ? h('p', { style: { ...SMALL, marginTop: '10px' } }, t.emptyQuery) : null,
        )

        // ---- 结果区 ----
        const hitCard = (hit, index) => {
          const title = hit && (hit.title || hit.path) ? String(hit.title || hit.path) : '—'
          const hitPath = hit && hit.path ? String(hit.path) : ''
          return h('div', {
            key: 'hit-' + index + '-' + hitPath,
            style: HIT_CARD,
          },
            h('div', { style: { ...ROW, justifyContent: 'space-between' } },
              h('span', { style: { fontSize: '13px', lineHeight: '20px', fontWeight: 500, wordBreak: 'break-all', flex: '1 1 auto', minWidth: 0 } }, title),
              hit && hit.heading ? h('span', { style: CHIP }, String(hit.heading)) : null,
              h('span', { style: CHIP }, t.score + ' ' + String(num(hit && hit.score))),
            ),
            h('div', { style: { ...SMALL, marginTop: '4px', wordBreak: 'break-all' } }, String(hit && hit.path ? hit.path : '')),
            h('div', { style: { ...SMALL, marginTop: '2px', wordBreak: 'break-word' } },
              String(hit && hit.collection ? hit.collection : '') + ' · ' + t.lines + ' ' + String(hit && hit.lines ? hit.lines : '—')),
            hit && hit.snippet ? h('div', { style: { ...SMALL, marginTop: '6px', wordBreak: 'break-word' } }, String(hit.snippet)) : null,
          )
        }

        const resultsSection = !searchState.ran || searchState.empty ? null : h('section', { style: SECTION },
          h('h2', { style: H2 }, t.results),
          searchState.error !== null
            ? h('p', { role: 'status', style: STATUS(false) }, t.failed + searchState.error)
            : searchState.loading
              ? h('p', { style: SMALL }, t.searching)
              : h('div', null,
                  h('div', { style: { ...SMALL, ...ROW, marginBottom: '10px', gap: '6px 12px' } },
                    h('span', null, t.results + ' · ' + t.hitUnit(hits.length)),
                    h('span', null, t.scope + ': ' + scopeText),
                    scopeWorkspace !== '' ? h('span', null, t.workspaceLabel + ': ' + scopeWorkspace) : null,
                  ),
                  hits.length === 0
                    ? h('p', { style: SMALL }, t.noResults)
                    : hits.map(hitCard),
                ),
        )

        // ---- 预览区 ----
        const previewSection = previewState.path === null ? null : h('section', { style: SECTION },
          h('div', { style: { ...ROW, marginBottom: '10px' } },
            h('span', { style: { fontSize: '13px', lineHeight: '20px', fontWeight: 600, wordBreak: 'break-all', flex: '1 1 auto', minWidth: 0 } },
              String(previewState.path)),
            previewData
              ? h('span', { style: CHIP }, t.pageInfo(num(previewData.from), num(previewData.to), num(previewData.totalLines)))
              : null,
            h('div', { style: { display: 'flex', alignItems: 'center' } },
              h('button', {
                type: 'button',
                style: { ...BTN, borderTopRightRadius: 0, borderBottomRightRadius: 0, paddingRight: '9px' },
                title: t.externalOpen,
                onClick: () => openExternal('default'),
              }, '📂 ' + t.externalOpen),
              h('button', {
                type: 'button',
                style: { ...BTN, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingLeft: '7px', paddingRight: '7px' },
                title: t.externalOpenChoose,
                'aria-label': t.externalOpenChoose,
                onClick: () => openExternal('choose'),
              }, '▾'),
            ),
            h('button', { type: 'button', style: BTN, disabled: previewState.loading || !previewData || num(previewData.from) <= 1, onClick: goPrev }, t.prevPage),
            h('button', {
              type: 'button', style: BTN,
              disabled: previewState.loading || !previewData || num(previewData.to) >= num(previewData.totalLines),
              onClick: goNext,
            }, t.nextPage),
            h('button', { type: 'button', style: BTN_GHOST, onClick: closePreview }, t.close),
            h(DeleteButton, {
              key: 'delete-preview',
              payload: { path: previewState.path },
              label: t.deleteDoc,
              confirmLabel: t.deleteDocConfirm,
              onDeleted: () => {
                closePreview()
                loadOverview()
                try {
                  let target = null
                  try { target = window } catch { target = null }
                  if (target && typeof target.dispatchEvent === 'function') target.dispatchEvent(new CustomEvent('dsh-corpus-originals-changed'))
                } catch { /* 刷新缩略图失败不影响删除 */ }
              },
            }),
          ),
          previewState.loading ? h('p', { style: SMALL }, t.loading) : null,
          previewState.error !== null ? h('p', { role: 'status', style: STATUS(false) }, t.readFailed + previewState.error) : null,
          previewData ? h('pre', { style: PRE }, numberedText(previewData)) : null,
        )

        // ---- 集合与重建 ----
        const collectionCard = (collection, index) => {
          const name = collection && collection.name ? String(collection.name) : 'collection-' + index
          return h('div', { key: 'collection-' + name, style: CARD },
            h('div', { style: ROW },
              h('span', { style: { fontSize: '13px', lineHeight: '20px', fontWeight: 600, wordBreak: 'break-all', flex: '1 1 auto', minWidth: 0 } }, name),
              collection && collection.backend ? h('span', { style: CHIP }, String(collection.backend)) : null,
              h('button', {
                type: 'button',
                style: { ...BTN, padding: '3px 10px', fontSize: '12px' },
                disabled: busy,
                onClick: () => startReindex({ collection: name }),
              }, t.reindex),
              h(DeleteButton, {
                key: 'delete-collection',
                payload: { collection: name },
                label: t.deleteCollection,
                confirmLabel: t.deleteCollectionConfirm,
                onDeleted: () => {
                  loadOverview()
                  try {
                    let target = null
                    try { target = window } catch { target = null }
                    if (target && typeof target.dispatchEvent === 'function') target.dispatchEvent(new CustomEvent('dsh-corpus-originals-changed'))
                  } catch { /* 刷新缩略图失败不影响删除 */ }
                },
              }),
            ),
            h('div', { style: { ...SMALL, ...ROW, gap: '4px 14px', marginTop: '6px' } },
              h('span', null, t.docs + ' ' + String(num(collection && collection.docs))),
              h('span', null, t.chunks + ' ' + String(num(collection && collection.chunks))),
              h('span', null, t.indexedAt + ' ' + formatTime(collection && collection.indexedAt)),
              h('span', null, t.indexBytes + ' ' + formatSize(collection && collection.indexBytes)),
              h('span', null, t.bytes + ' ' + formatSize(collection && collection.bytes)),
            ),
          )
        }

        const forceButtons = pendingForce
          ? h(React.Fragment, null,
              h('button', { type: 'button', style: BTN_PRIMARY, disabled: busy, onClick: () => startReindex({ force: true }) }, t.confirmForce),
              h('button', { type: 'button', style: BTN_GHOST, disabled: busy, onClick: () => setPendingForce(false) }, t.cancel),
            )
          : h('button', { type: 'button', style: BTN, disabled: busy, onClick: () => setPendingForce(true) }, t.reindexForceAll)

        const activeJobLine = active === null ? null : h('div', { style: { ...SMALL, marginBottom: '10px' } },
          t.progress + ' ',
          active.progress && typeof active.progress === 'object'
            ? t.progressLine(String(active.progress.collection || ''), num(active.progress.index), num(active.progress.total))
            : (Array.isArray(active.names) && active.names.length > 0 ? active.names.join(', ') : t.allCollections),
          ' · ' + (active.force === true ? t.forceMode : t.incremental),
        )

        const lastJobLine = active === null && lastJob !== null
          ? h('div', { style: { ...SMALL, marginBottom: '10px' } },
              t.recentJob + ': ' + jobStateText(t, lastJob) + (num(lastJob.ms) > 0 ? ' · ' + t.jobUnit(num(lastJob.ms)) : '') + ' · ' + formatTime(lastJob.finishedAt || lastJob.startedAt))
          : null

        const collectionsSection = h('section', { style: SECTION },
          h('h2', { style: H2 }, t.collectionsTitle),
          h('div', { style: { ...ROW, marginBottom: '12px' } },
            h('button', { type: 'button', style: BTN, disabled: busy, onClick: () => startReindex({}) }, busy ? t.reindexing : t.reindexAll),
            forceButtons,
            h(ReindexHelp),
          ),
          jobNote !== null ? h('p', { role: 'status', style: STATUS(jobNote.ok) }, jobNote.text) : null,
          statusInfo.error !== null ? h('p', { role: 'status', style: STATUS(false) }, t.pollFailed + statusInfo.error) : null,
          activeJobLine,
          lastJobLine,
          overviewData === null
            ? h('p', { style: SMALL }, overview.loading ? t.loading : t.overviewUnavailable)
            : collections.length === 0
              ? h('p', { style: SMALL }, t.noCollections)
              : collections.map(collectionCard),
        )

        // ---- 策略区（只读摘要 + 右栏编辑入口） ----
        const permissionsAvailable = typeof permissionsOpenTab === 'function'
        const policySection = h('section', { style: SECTION },
          h('div', { style: { ...ROW, marginBottom: '10px' } },
            h('h2', { style: { ...H2, margin: '0 auto 0 0' } }, t.policyTitle),
            h('button', {
              type: 'button',
              style: BTN,
              disabled: !permissionsAvailable,
              title: permissionsAvailable ? t.openPermissions : t.openPermissionsHint,
              onClick: openPermissions,
            }, t.openPermissions),
          ),
          permissionsAvailable ? null : h('p', { style: SMALL }, t.openPermissionsHint),
          permissionsNote !== null ? h('p', { role: 'status', style: STATUS(permissionsNote.ok) }, permissionsNote.text) : null,
          policy === null
            ? h('p', { style: SMALL }, overview.loading ? t.loading : t.policyUnavailable)
            : h('div', null,
                h('div', { style: { ...SMALL, wordBreak: 'break-all', marginBottom: '4px' } },
                  t.policyFile + ': ' + String(policy.accessFile || '—')),
                h('div', { style: { ...SMALL, marginBottom: '4px' } },
                  t.policyStatus + ': ' + (policy.exists === true ? t.policyExists : t.policyMissing)),
                h('div', { style: { ...SMALL, marginBottom: '8px' } },
                  t.policyDefault + ': ' + String(policy.default || 'deny')),
                typeof policy.error === 'string' && policy.error !== ''
                  ? h('p', { role: 'status', style: STATUS(false) }, t.policyParseError + policy.error)
                  : null,
                policy.exists === true ? null : h('p', { style: { ...SMALL, marginBottom: '10px' } }, t.policyFallback),
                h('div', { style: { fontSize: '12px', lineHeight: '18px', fontWeight: 600, margin: '10px 0 4px' } }, t.policyGrants),
                RuleList(t, policy.grants, t.policyNoGrants),
                h('div', { style: { fontSize: '12px', lineHeight: '18px', fontWeight: 600, margin: '10px 0 4px' } }, t.policyDeny),
                RuleList(t, policy.deny, t.policyNoDeny),
                h('p', { style: FOOT }, t.policyReadonly),
              ),
        )

        // ---- 导入语料区（v1.3）：页面头部按钮展开/收起，完成后刷新 overview ----
        const importSection = importOpen
          ? h(ImportSection, {
              key: 'import-section',
              collections,
              onImported: () => { loadOverview() },
              onClose: () => setImportOpen(false),
            })
          : null

        return h('div', { style: PAGE },
          h('div', { style: INNER },
            header,
            h('p', { style: DESC }, t.desc),
            overviewError,
            rootLine,
            statsRow,
            importSection,
            h(CorpusRootSettings, {
              key: 'root-settings',
              root: overviewData ? String(overviewData.root || '') : '',
              onChanged: () => { loadOverview() },
            }),
            h(CorpusGallery, {
              key: 'corpus-gallery',
              collections,
              onExternal: (item, target, mode) => {
                const path = target === 'original' && item.original ? item.original : item.path
                openExternal(path, mode === 'default' ? 'default' : 'choose')
              },
              onDeleted: () => { loadOverview() },
            }),
            h('div', { style: GRID },
              h('div', { style: COLUMN }, searchSection, resultsSection),
              h('div', { style: COLUMN }, collectionsSection, policySection),
            ),
            h('p', { style: FOOT }, t.foot),
          ),
        )
      }

      /**
       * 右栏「语料查看」面板：文件列表点击后通过模块级事件把请求推到这里。
       */
      function PreviewPanel() {
        const t = copy()
        const [request, setRequest] = React.useState(previewRequest)
        const [state, setState] = React.useState({ loading: false, error: null, data: null })

        const load = React.useCallback((target) => {
          if (!target || typeof target.path !== 'string' || target.path === '') return
          setState({ loading: true, error: null, data: null })
          postJson(API.read, { path: target.path, from: Math.max(1, num(target.from) || 1), lines: PAGE_LINES })
            .then((body) => setState({ loading: false, error: null, data: body }))
            .catch((error) => setState({ loading: false, error: errorText(error), data: null }))
        }, [])

        React.useEffect(() => {
          const subscriber = (next) => setRequest(next)
          previewSubscribers.add(subscriber)
          return () => { previewSubscribers.delete(subscriber) }
        }, [])

        React.useEffect(() => { load(request) }, [request, load])

        const openExternal = (mode) => {
          if (!request || typeof request.path !== 'string') return
          postJson(API.openExternal, { path: request.path, mode }).catch((error) => {
            setState((prev) => ({ ...prev, error: t.externalOpenFailed + errorText(error) }))
          })
        }

        const go = (from) => {
          if (!request) return
          const next = { ...request, from: Math.max(1, num(from) || 1) }
          setRequest(next)
        }

        if (!request) {
          return h('section', { style: SECTION },
            h('h2', { style: H2 }, t.previewTabTitle),
            h('p', { style: SMALL }, t.previewEmpty))
        }

        const data = state.data
        const from = num(data && data.from) || num(request.from) || 1
        const to = num(data && data.to) || from
        const total = num(data && data.totalLines) || 0
        return h('section', { style: SECTION },
          h('h2', { style: H2 }, t.previewTabTitle),
          h('div', { style: { ...ROW, marginBottom: '8px' } },
            h('span', { style: { ...SMALL, wordBreak: 'break-all', flex: '1 1 auto', minWidth: 0 } }, request.path),
            data ? h('span', { style: CHIP }, t.pageInfo(from, to, total)) : null,
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' } },
            h('div', { style: { display: 'flex', alignItems: 'center' } },
              h('button', {
                type: 'button',
                style: { ...BTN, borderTopRightRadius: 0, borderBottomRightRadius: 0, paddingRight: '9px' },
                title: t.externalOpen,
                onClick: () => openExternal('default'),
              }, '📂 ' + t.externalOpen),
              h('button', {
                type: 'button',
                style: { ...BTN, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingLeft: '7px', paddingRight: '7px' },
                title: t.externalOpenChoose,
                'aria-label': t.externalOpenChoose,
                onClick: () => openExternal('choose'),
              }, '▾'),
            ),
            h('button', {
              type: 'button', style: BTN,
              disabled: state.loading || !data || from <= 1,
              onClick: () => go(from - PAGE_LINES),
            }, t.prevPage),
            h('button', {
              type: 'button', style: BTN,
              disabled: state.loading || !data || to >= total,
              onClick: () => go(to + 1),
            }, t.nextPage),
          ),
          state.loading ? h('p', { style: SMALL }, t.loading) : null,
          state.error !== null ? h('p', { role: 'status', style: STATUS(false) }, t.readFailed + state.error) : null,
          data ? h('pre', { style: { ...PRE, maxHeight: 'none' } }, numberedText(data)) : null,
        )
      }

      /**
       * 右栏「语料权限」面板（Session scope 的 sessionId prop，窄栏布局）。
       * 写操作统一：GET /policy → 修改 → POST /policy → 用返回值更新并重新 GET /access。
       */
      function PermissionsPanel(props) {
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
        const t = copy()
        const [access, setAccess] = React.useState({ loading: true, error: null, data: null })
        const [busy, setBusy] = React.useState(false)
        const [note, setNote] = React.useState(null)
        const [writeErrors, setWriteErrors] = React.useState([])
        const [sessionDraft, setSessionDraft] = React.useState('')
        const [workspaceDraft, setWorkspaceDraft] = React.useState('')
        const [denyDraft, setDenyDraft] = React.useState('')
        const [sessionExpiry, setSessionExpiry] = React.useState('0')
        const [workspaceExpiry, setWorkspaceExpiry] = React.useState('0')
        const mountedRef = React.useRef(true)

        const loadAccess = () => {
          const suffix = sessionId === '' ? '' : '?session=' + encodeURIComponent(sessionId)
          setAccess((prev) => ({ ...prev, loading: true, error: null }))
          getJson(API.access + suffix).then((body) => {
            if (!mountedRef.current) return
            setAccess({ loading: false, error: null, data: body })
          }).catch((error) => {
            if (!mountedRef.current) return
            setAccess((prev) => ({ loading: false, error: errorText(error), data: prev.data }))
          })
        }

        React.useEffect(() => {
          mountedRef.current = true
          loadAccess()
          return () => { mountedRef.current = false }
        }, [sessionId])

        const data = access.data
        const policy = data && data.policy && typeof data.policy === 'object' ? data.policy : null
        const grants = policy && Array.isArray(policy.grants) ? policy.grants : []
        const denies = policy && Array.isArray(policy.deny) ? policy.deny : []
        const workspace = data && typeof data.workspace === 'string' ? data.workspace : ''
        const workspaceKey = data && typeof data.workspaceKey === 'string' && data.workspaceKey !== '' ? data.workspaceKey : workspace
        const collectionList = data && Array.isArray(data.collections) ? data.collections : []
        const effective = data && Array.isArray(data.effectiveCollections) ? data.effectiveCollections : []
        const sessionRules = sessionId === '' ? [] : grants.filter((rule) => rule && rule.session === sessionId)
        const workspaceRules = workspaceKey === ''
          ? []
          : grants.filter((rule) => rule && typeof rule.workspace === 'string' && rule.workspace !== '*' && sameWorkspace(rule.workspace, workspaceKey))
        const otherGrants = grants.filter((rule) => sessionRules.indexOf(rule) === -1 && workspaceRules.indexOf(rule) === -1)
        const currentDefault = policy && policy.default === 'allow' ? 'allow' : 'deny'
        const accessFile = policy && typeof policy.accessFile === 'string' ? policy.accessFile : ''

        /** 读当前 policy → 改 → POST；成功后用返回 policy 更新并重拉 /access。 */
        const writePolicy = (mutator, successText, clearDraft) => {
          setBusy(true)
          setNote(null)
          setWriteErrors([])
          getJson(API.policy).then((summary) => {
            const next = mutator(policyFromSummary(summary))
            return postJson(API.policy, { policy: next })
          }).then((body) => {
            if (!mountedRef.current) return
            setBusy(false)
            setNote({ ok: true, text: successText })
            if (clearDraft === 'session') setSessionDraft('')
            if (clearDraft === 'workspace') setWorkspaceDraft('')
            if (clearDraft === 'deny') setDenyDraft('')
            setAccess((prev) => ({
              ...prev,
              data: prev.data ? { ...prev.data, policy: body && body.policy ? body.policy : prev.data.policy } : prev.data,
            }))
            loadAccess()
          }).catch((error) => {
            if (!mountedRef.current) return
            setBusy(false)
            setNote({ ok: false, text: t.failed + errorText(error) })
            setWriteErrors(Array.isArray(error && error.errors) ? error.errors.map((item) => String(item)) : [])
          })
        }

        const addSessionRule = () => {
          if (sessionId === '') {
            setNote({ ok: false, text: t.permNoSession })
            setWriteErrors([])
            return
          }
          const paths = parsePaths(sessionDraft)
          if (paths.length === 0) {
            setNote({ ok: false, text: t.permPathsRequired })
            setWriteErrors([])
            return
          }
          const expiresAt = expiryToExpiresAt(sessionExpiry)
          writePolicy((next) => {
            const rule = { session: sessionId, paths }
            if (expiresAt !== null) rule.expiresAt = expiresAt
            next.grants.push(rule)
            return next
          }, t.permRuleAdded, 'session')
        }

        const addWorkspaceRule = () => {
          if (workspace === '') {
            setNote({ ok: false, text: t.permWorkspaceUnavailable })
            setWriteErrors([])
            return
          }
          const paths = parsePaths(workspaceDraft)
          if (paths.length === 0) {
            setNote({ ok: false, text: t.permPathsRequired })
            setWriteErrors([])
            return
          }
          const expiresAt = expiryToExpiresAt(workspaceExpiry)
          writePolicy((next) => {
            const rule = { workspace, paths }
            if (expiresAt !== null) rule.expiresAt = expiresAt
            next.grants.push(rule)
            return next
          }, t.permRuleAdded, 'workspace')
        }

        const addDenyRule = () => {
          const paths = parsePaths(denyDraft)
          if (paths.length === 0) {
            setNote({ ok: false, text: t.permPathsRequired })
            setWriteErrors([])
            return
          }
          writePolicy((next) => {
            next.deny.push({ paths })
            return next
          }, t.permDenyAdded, 'deny')
        }

        const removeGrant = (rule) => {
          writePolicy((next) => {
            const index = next.grants.findIndex((item) => sameRule(item, rule))
            if (index !== -1) next.grants.splice(index, 1)
            return next
          }, t.permRuleDeleted, null)
        }

        const removeDeny = (rule) => {
          writePolicy((next) => {
            const index = next.deny.findIndex((item) => sameRule(item, rule))
            if (index !== -1) next.deny.splice(index, 1)
            return next
          }, t.permRuleDeleted, null)
        }

        const setDefault = (value) => {
          writePolicy((next) => {
            next.default = value
            return next
          }, t.permDefaultSaved, null)
        }

        // ---- 复用片段 ----
        const expirySelect = (value, setValue) => h('select', {
          value,
          style: PERM_SELECT,
          disabled: busy,
          'aria-label': t.permExpiry,
          onChange: (event) => setValue(event && event.target ? event.target.value : '0'),
        }, expiryOptions(t).map((option) => h('option', { key: 'expiry-' + option.value, value: option.value }, option.label)))

        const collectionChips = (value, setValue) => {
          const names = collectionList.map((item) => String(item && item.name ? item.name : '')).filter((name) => name !== '')
          if (names.length === 0) return null
          return h('div', { style: PERM_CHIPS_ROW },
            h('span', { style: PERM_LABEL }, t.permCollections + ':'),
            names.slice(0, 30).map((name, index) => h('button', {
              type: 'button',
              key: 'chip-' + index + '-' + name,
              style: PERM_CHIP_BTN,
              disabled: busy,
              onClick: () => setValue(appendPath(value, name)),
            }, name)),
          )
        }

        const ruleRow = (rule, index, showSubject) => {
          const expired = ruleExpired(rule)
          return h('div', { key: 'rule-' + index, style: PERM_RULE },
            h('div', { style: PERM_RULE_TOP },
              h('span', { style: PERM_RULE_PATHS }, formatPaths(rule && rule.paths) || '—'),
              h('button', {
                type: 'button',
                style: PERM_DELETE,
                disabled: busy,
                title: t.permDelete,
                onClick: () => removeGrant(rule),
              }, t.permDelete),
            ),
            h('div', { style: PERM_RULE_META },
              showSubject ? h('span', null, subjectLabel(t, rule)) : null,
              h('span', { style: expired ? { color: 'var(--dsw-alias-state-error-primary)' } : null }, expiryText(t, rule)),
            ),
          )
        }

        const denyRow = (rule, index) => h('div', { key: 'deny-' + index, style: PERM_RULE },
          h('div', { style: PERM_RULE_TOP },
            h('span', { style: PERM_RULE_PATHS }, formatPaths(rule && rule.paths) || '—'),
            h('button', {
              type: 'button',
              style: PERM_DELETE,
              disabled: busy,
              title: t.permDelete,
              onClick: () => removeDeny(rule),
            }, t.permDelete),
          ),
          h('div', { style: PERM_RULE_META },
            h('span', null, subjectLabel(t, rule)),
            h('span', { style: ruleExpired(rule) ? { color: 'var(--dsw-alias-state-error-primary)' } : null }, expiryText(t, rule)),
          ),
        )

        // ---- loading / error（所有 hook 已调用完） ----
        if (access.loading && data === null) {
          return h('div', { style: PERM_PAGE },
            h('p', { style: SMALL }, t.permLoading),
            sessionId === '' ? h('p', { style: SMALL }, t.permNoSession) : null,
          )
        }
        if (access.error !== null && data === null) {
          return h('div', { style: PERM_PAGE },
            h('p', { role: 'status', style: STATUS(false) }, t.permLoadFailed + access.error),
            h('button', { type: 'button', style: BTN, disabled: busy, onClick: loadAccess }, t.permRetry),
            sessionId === '' ? h('p', { style: SMALL }, t.permNoSession) : null,
          )
        }

        const sessionSection = h('section', { style: PERM_SECTION },
          h('div', { style: PERM_HEAD },
            h('h2', { style: PERM_H2 }, t.permSession),
            h('span', { style: CHIP, title: sessionId }, shortId(sessionId) || '—'),
          ),
          h('p', { style: PERM_TEXT }, t.policySubjectWorkspace + ': ' + (workspace || '—')),
          h('div', { style: PERM_LABEL }, t.permEffective),
          effective.length === 0
            ? h('p', { style: PERM_TEXT }, t.permNoEffective)
            : h('div', { style: PERM_CHIPS_ROW },
                effective.map((name, index) => h('span', { key: 'effective-' + index, style: CHIP }, String(name)))),
          h('div', { style: { ...PERM_LABEL, marginTop: '10px', fontWeight: 600 } }, t.permSessionRules),
          sessionRules.length === 0
            ? h('p', { style: PERM_TEXT }, t.permNoSessionRules)
            : sessionRules.map((rule, index) => ruleRow(rule, index, false)),
          h('textarea', {
            value: sessionDraft,
            rows: 2,
            placeholder: t.permPathsPlaceholder,
            style: { ...PERM_TEXTAREA, marginTop: '8px' },
            disabled: busy,
            'aria-label': t.permPathsPlaceholder,
            onChange: (event) => setSessionDraft(event && event.target ? event.target.value : ''),
          }),
          collectionChips(sessionDraft, setSessionDraft),
          h('div', { style: PERM_FORM_ROW },
            expirySelect(sessionExpiry, setSessionExpiry),
            h('button', {
              type: 'button',
              style: BTN_PRIMARY,
              disabled: busy || sessionId === '',
              onClick: addSessionRule,
            }, busy ? t.permBusy : t.permGrantSession),
          ),
          sessionId === '' ? h('p', { style: PERM_TEXT }, t.permNoSession) : null,
        )

        const workspaceReady = workspace !== ''
        const workspaceSection = h('section', { style: PERM_SECTION },
          h('div', { style: PERM_HEAD }, h('h2', { style: PERM_H2 }, t.permWorkspace)),
          h('p', { style: PERM_TEXT }, workspaceReady ? workspace : t.permWorkspaceUnavailable),
          h('div', { style: { ...PERM_LABEL, marginTop: '10px', fontWeight: 600 } }, t.permWorkspaceRules),
          workspaceRules.length === 0
            ? h('p', { style: PERM_TEXT }, t.permNoWorkspaceRules)
            : workspaceRules.map((rule, index) => ruleRow(rule, index, false)),
          workspaceReady ? h('div', null,
            h('textarea', {
              value: workspaceDraft,
              rows: 2,
              placeholder: t.permPathsPlaceholder,
              style: { ...PERM_TEXTAREA, marginTop: '8px' },
              disabled: busy,
              'aria-label': t.permPathsPlaceholder,
              onChange: (event) => setWorkspaceDraft(event && event.target ? event.target.value : ''),
            }),
            collectionChips(workspaceDraft, setWorkspaceDraft),
            h('div', { style: PERM_FORM_ROW },
              expirySelect(workspaceExpiry, setWorkspaceExpiry),
              h('button', { type: 'button', style: BTN_PRIMARY, disabled: busy, onClick: addWorkspaceRule }, busy ? t.permBusy : t.permGrantWorkspace),
            ),
          ) : null,
        )

        const defaultButton = (value, label) => h('button', {
          type: 'button',
          style: currentDefault === value ? BTN_PRIMARY : BTN,
          disabled: busy || currentDefault === value,
          onClick: () => setDefault(value),
        }, label)

        const globalSection = h('section', { style: PERM_SECTION },
          h('div', { style: PERM_HEAD }, h('h2', { style: PERM_H2 }, t.permGlobal)),
          h('div', { style: PERM_FORM_ROW },
            h('span', { style: PERM_LABEL }, t.permDefaultLabel + ':'),
            defaultButton('allow', t.permDefaultAllow),
            defaultButton('deny', t.permDefaultDeny),
          ),
          h('p', { style: PERM_TEXT }, t.permDefaultHint),
          h('div', { style: { ...PERM_LABEL, marginTop: '10px', fontWeight: 600 } }, t.permDenyRules),
          denies.length === 0
            ? h('p', { style: PERM_TEXT }, t.permNoDenyRules)
            : denies.map((rule, index) => denyRow(rule, index)),
          h('textarea', {
            value: denyDraft,
            rows: 2,
            placeholder: t.permPathsPlaceholder,
            style: { ...PERM_TEXTAREA, marginTop: '8px' },
            disabled: busy,
            'aria-label': t.permPathsPlaceholder,
            onChange: (event) => setDenyDraft(event && event.target ? event.target.value : ''),
          }),
          collectionChips(denyDraft, setDenyDraft),
          h('div', { style: PERM_FORM_ROW },
            h('button', { type: 'button', style: BTN_PRIMARY, disabled: busy, onClick: addDenyRule }, busy ? t.permBusy : t.permAddDeny),
          ),
        )

        const otherSection = h('details', { style: PERM_SECTION },
          h('summary', { style: PERM_SUMMARY }, t.permOtherRules + ' · ' + String(otherGrants.length)),
          h('p', { style: PERM_TEXT }, t.permOtherHint),
          otherGrants.length === 0
            ? h('p', { style: PERM_TEXT }, t.permNoOtherRules)
            : otherGrants.map((rule, index) => ruleRow(rule, index, true)),
        )

        const noticeParts = []
        if (access.loading) noticeParts.push(h('p', { key: 'notice-loading', style: SMALL }, t.permLoading))
        if (busy) noticeParts.push(h('p', { key: 'notice-busy', role: 'status', style: SMALL }, t.permBusy))
        if (note !== null) noticeParts.push(h('p', { key: 'notice-note', role: 'status', style: STATUS(note.ok) }, note.text))
        if (writeErrors.length > 0) {
          noticeParts.push(h('div', { key: 'notice-errors', role: 'status', style: STATUS(false) },
            h('div', null, t.permValidationFailed),
            h('ul', { style: PERM_LIST }, writeErrors.map((message, index) => h('li', { key: 'write-error-' + index }, message))),
          ))
        }
        if (policy && typeof policy.error === 'string' && policy.error !== '') {
          noticeParts.push(h('p', { key: 'notice-policy-error', role: 'status', style: STATUS(false) }, t.permPolicyError + policy.error))
        }
        const noticeBlock = noticeParts.length === 0 ? null : h('div', { style: PERM_NOTICE }, noticeParts)

        return h('div', { style: PERM_PAGE },
          h('div', { style: PERM_STACK },
            noticeBlock,
            sessionSection,
            workspaceSection,
            globalSection,
            otherSection,
            h('p', { style: PERM_FOOT }, t.permAccessFile + ': ' + (accessFile || '—')),
            h('p', { style: PERM_FOOT }, t.permBackupHint),
            h('p', { style: PERM_FOOT }, t.permEffectHint),
          ),
        )
      }

      /**
       * 主页面「导入语料」区（页面头部按钮展开；不是右栏 tab）。
       * 流程：GET /import/targets 加载集合/格式/提取器 → 选来源与目标 → POST /import
       * → 每 1s GET /import/status 显示阶段/进度 → 完成刷新 overview 并提示 reindexJobId。
       *
       * props: { collections, onImported, onClose }
       * hook 顺序固定（tests/test-client-bundle.mjs 用 seed.byIndex 注入状态）：
       *   0 targets / 1 sourceMode / 2 files / 3 fileNote / 4 reading / 5 pathInput /
       *   6 collectionDraft / 7 prefix / 8 aiEnabled / 9 jobInfo / 10 starting /
       *   11 note / 12 result
       */
      function ImportSection(props) {
        const t = copy()
        const pageCollections = props && Array.isArray(props.collections) ? props.collections : []
        const [targets, setTargets] = React.useState({ loading: true, error: null, data: null })
        const [sourceMode, setSourceMode] = React.useState('files')
        const [files, setFiles] = React.useState([])
        const [fileNote, setFileNote] = React.useState(null)
        const [reading, setReading] = React.useState(false)
        const [pathInput, setPathInput] = React.useState('')
        const [collectionDraft, setCollectionDraft] = React.useState('')
        const [prefix, setPrefix] = React.useState('')
        const [aiEnabled, setAiEnabled] = React.useState(true)
        const [jobInfo, setJobInfo] = React.useState({ active: null, recent: [], error: null })
        const [starting, setStarting] = React.useState(false)
        const [note, setNote] = React.useState(null)
        const [result, setResult] = React.useState(null)
        const mountedRef = React.useRef(true)
        const pollRef = React.useRef({ timer: null, generation: 0, hadActive: false })

        // ---- 派生状态（集合优先用主页面已加载的 collections） ----
        const targetsData = targets.data !== null && targets.data !== undefined && typeof targets.data === 'object' ? targets.data : null
        const targetsCollections = targetsData !== null && Array.isArray(targetsData.collections) ? targetsData.collections : []
        const collectionSource = pageCollections.length > 0 ? pageCollections : targetsCollections
        const formats = targetsData !== null && Array.isArray(targetsData.formats) && targetsData.formats.length > 0
          ? targetsData.formats.map(normalizeFormat).filter((item) => item !== '')
          : DEFAULT_FORMATS.slice()
        const extractors = targetsData !== null && targetsData.extractors !== null && typeof targetsData.extractors === 'object' ? targetsData.extractors : {}
        const limits = targetsData !== null && targetsData.limits !== null && typeof targetsData.limits === 'object' ? targetsData.limits : {}
        const maxUploadBytes = num(limits.maxUploadBytes) > 0 ? num(limits.maxUploadBytes) : MAX_UPLOAD_BYTES
        const maxFiles = num(limits.maxFiles) > 0 ? num(limits.maxFiles) : MAX_FILES
        const aiAvailable = targetsData === null ? true : targetsData.aiAvailable !== false
        const aiOn = aiEnabled && aiAvailable
        const activeJob = jobInfo.active !== null && jobInfo.active !== undefined && typeof jobInfo.active === 'object' ? jobInfo.active : null
        const readingFiles = reading === true
        const busy = starting === true || activeJob !== null || readingFiles
        const collectionOptions = collectionSource.map((item) => {
          const name = item && typeof item.name === 'string' ? item.name : ''
          return name === '' ? null : { name, docs: num(item && item.docs) }
        }).filter((item) => item !== null)
        const collectionNames = collectionOptions.map((item) => item.name)

        // ---- 目标加载 / 状态加载 / 1s 轮询 ----
        const loadTargets = () => {
          setTargets((prev) => ({ ...prev, loading: true, error: null }))
          return getJson(API.importTargets).then((body) => {
            if (!mountedRef.current) return
            setTargets({ loading: false, error: null, data: body })
          }).catch((error) => {
            if (!mountedRef.current) return
            setTargets((prev) => ({ loading: false, error: errorText(error), data: prev.data }))
          })
        }

        const startPolling = () => {
          const gate = pollRef.current
          if (gate.timer !== null) return
          gate.generation += 1
          const generation = gate.generation
          const tick = () => {
            getJson(API.importStatus).then((body) => {
              if (!mountedRef.current || gate.generation !== generation) return
              const tr = copy()
              const active = body.active ? body.active : null
              const recent = Array.isArray(body.recent) ? body.recent : []
              setJobInfo({ active, recent, error: null })
              if (active !== null) {
                gate.hadActive = true
                gate.timer = setTimeout(tick, IMPORT_POLL_MS)
                return
              }
              gate.timer = null
              const wasActive = gate.hadActive
              gate.hadActive = false
              setStarting(false)
              if (!wasActive) return
              const last = recent.length > 0 ? recent[0] : null
              setNote(last === null
                ? { ok: true, text: tr.importDone }
                : { ok: last.state !== 'error', text: importResultText(tr, last) })
              if (last !== null) setResult(last)
              loadTargets()
              // 契约：完成后刷新 overview（集合索引变化）；由主页面重新加载。
              if (props && typeof props.onImported === 'function') {
                try { props.onImported() } catch { /* 刷新失败不影响导入结果 */ }
              }
              try {
                let target = null
                try { target = window } catch { target = null }
                if (target && typeof target.dispatchEvent === 'function') {
                  target.dispatchEvent(new CustomEvent('dsh-corpus-originals-changed'))
                }
              } catch { /* 刷新原件失败不影响导入结果 */ }
            }).catch((error) => {
              if (!mountedRef.current || gate.generation !== generation) return
              const tr = copy()
              gate.timer = null
              gate.hadActive = false
              setStarting(false)
              setJobInfo((prev) => ({ ...prev, active: null, error: errorText(error) }))
              setNote({ ok: false, text: tr.importPollFailed + errorText(error) })
            })
          }
          tick()
        }

        const loadStatus = () => getJson(API.importStatus).then((body) => {
          if (!mountedRef.current) return
          const active = body.active ? body.active : null
          setJobInfo({ active, recent: Array.isArray(body.recent) ? body.recent : [], error: null })
          if (active !== null) {
            pollRef.current.hadActive = true
            startPolling()
          }
        }).catch((error) => {
          if (!mountedRef.current) return
          setJobInfo((prev) => ({ ...prev, error: errorText(error) }))
        })

        // ---- 文件选择（FileReader → base64，单文件 ≤ 上限） ----
        const removeFile = (index) => setFiles((prev) => prev.filter((item, position) => position !== index))

        const addFiles = (event) => {
          const list = event && event.target && event.target.files ? event.target.files : []
          const picked = Array.prototype.slice.call(list)
          if (picked.length === 0) return
          // 允许再次选择同一个文件（file input 的 value 不清空不会再触发 change）。
          try { if (event && event.target) event.target.value = '' } catch { /* 某些环境只读 */ }
          setReading(true)
          setFileNote(null)
          const problems = []
          let count = files.length
          const reads = picked.map((file) => {
            const name = String(file && file.name ? file.name : 'file')
            const size = num(file && file.size)
            const ext = extensionOf(name)
            if (formats.indexOf(ext) === -1) {
              problems.push(t.importUnsupported + name)
              return Promise.resolve(null)
            }
            if (size > maxUploadBytes) {
              problems.push(t.importTooLarge + name + ' (' + formatSize(size) + ')')
              return Promise.resolve(null)
            }
            if (count >= maxFiles) {
              problems.push(t.importTooMany + String(maxFiles))
              return Promise.resolve(null)
            }
            count += 1
            return readFileAsBase64(file).then((dataBase64) => ({ name, size, dataBase64 })).catch((error) => {
              problems.push(t.importReadFailed + name + ': ' + errorText(error))
              return null
            })
          })
          return Promise.all(reads).then((items) => {
            if (!mountedRef.current) return
            setReading(false)
            const good = items.filter((item) => item !== null)
            if (good.length > 0) setFiles((prev) => prev.concat(good))
            setFileNote(problems.length > 0
              ? { ok: false, text: problems.join('；') }
              : (good.length > 0 ? { ok: true, text: t.importFilesAdded(good.length) } : null))
          })
        }

        // ---- 提交导入 ----
        const autoCollectionName = () => {
          const now = new Date()
          const pad = (value) => String(value).padStart(2, '0')
          return 'import-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
        }

        const startImport = () => {
          if (busy) return
          const tr = copy()
          let chosen = collectionDraft !== ''
            ? collectionDraft
            : collectionNames.length === 1 ? collectionNames[0] : ''
          if (chosen === '') {
            chosen = autoCollectionName()
            setCollectionDraft(chosen)
          }
          const payload = { collection: chosen, ai: aiOn }
          const prefixText = prefix.trim()
          if (prefixText !== '') payload.prefix = prefixText
          if (sourceMode === 'files') {
            if (files.length === 0) {
              setNote({ ok: false, text: tr.importNoFiles })
              return
            }
            payload.files = files.map((file) => ({ name: String(file.name), dataBase64: String(file.dataBase64 || '') }))
          } else {
            const pathText = pathInput.trim()
            if (pathText === '') {
              setNote({ ok: false, text: tr.importPathRequired })
              return
            }
            const paths = pathText.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean)
            if (paths.length === 0) {
              setNote({ ok: false, text: tr.importPathRequired })
              return
            }
            payload.paths = paths
          }
          setStarting(true)
          setNote(null)
          setResult(null)
          postJson(API.importStart, payload, { allowFalse: true }).then((body) => {
            if (!mountedRef.current) return
            setStarting(false)
            if (body.ok !== true) {
              if (body.busy === true) {
                setNote({ ok: false, text: tr.importBusy })
                if (body.job && typeof body.job === 'object') setJobInfo({ active: body.job, recent: [], error: null })
                pollRef.current.hadActive = true
                startPolling()
                return
              }
              setNote({ ok: false, text: tr.importErrorNote + String(body.error || '') })
              return
            }
            setNote({ ok: true, text: tr.importStarted })
            if (body.job && typeof body.job === 'object') setJobInfo({ active: body.job, recent: [], error: null })
            pollRef.current.hadActive = true
            startPolling()
          }).catch((error) => {
            if (!mountedRef.current) return
            setStarting(false)
            setNote({ ok: false, text: tr.importErrorNote + errorText(error) })
          })
        }

        React.useEffect(() => {
          mountedRef.current = true
          loadTargets()
          loadStatus()
          return () => {
            mountedRef.current = false
            const gate = pollRef.current
            gate.generation += 1
            if (gate.timer !== null) {
              clearTimeout(gate.timer)
              gate.timer = null
            }
          }
        }, [])

        // ---- loading / error（所有 hook 已调用完；主页面已有集合时先给表单） ----
        if (targetsData === null && targets.loading && pageCollections.length === 0) {
          return h('section', { style: { ...SECTION, marginTop: '18px' } },
            h('p', { style: SMALL }, t.importTargetsLoading))
        }
        if (targetsData === null && targets.error !== null && pageCollections.length === 0) {
          return h('section', { style: { ...SECTION, marginTop: '18px' } },
            h('p', { role: 'status', style: STATUS(false) }, t.importTargetsFailed + targets.error),
            h('button', { type: 'button', style: BTN, onClick: loadTargets }, t.permRetry),
          )
        }

        // ---- 来源区 ----
        const modeButton = (mode, label) => h('button', {
          type: 'button',
          key: 'source-mode-' + mode,
          style: sourceMode === mode ? BTN_PRIMARY : BTN,
          disabled: busy,
          onClick: () => setSourceMode(mode),
        }, label)

        const fileInput = h('input', {
          type: 'file',
          multiple: true,
          accept: formats.join(','),
          disabled: busy,
          style: PERM_FILE_INPUT,
          'aria-label': t.importChooseFiles,
          onChange: addFiles,
        })

        const fileRows = files.length === 0
          ? h('p', { style: PERM_TEXT }, t.importNoFiles)
          : h('div', null, files.map((file, index) => h('div', {
              key: 'file-' + index + '-' + String(file && file.name ? file.name : ''),
              style: PERM_RULE,
            },
              h('div', { style: PERM_RULE_TOP },
                h('span', { style: PERM_RULE_PATHS }, String(file && file.name ? file.name : '—')),
                h('button', {
                  type: 'button',
                  style: PERM_DELETE,
                  disabled: busy,
                  title: t.importRemoveFile,
                  onClick: () => removeFile(index),
                }, t.importRemoveFile),
              ),
              h('div', { style: PERM_RULE_META }, h('span', null, formatSize(file && file.size))),
            )))

        const sourceSection = h('section', { style: PERM_SECTION },
          h('div', { style: PERM_HEAD }, h('h2', { style: PERM_H2 }, t.importSource)),
          h('div', { style: PERM_FORM_ROW },
            modeButton('files', t.importModeFiles),
            modeButton('path', t.importModePath),
          ),
          sourceMode === 'files'
            ? h('div', null,
                fileInput,
                h('p', { style: PERM_TEXT }, t.importFilesHint),
                readingFiles ? h('p', { style: PERM_TEXT }, t.importReading) : null,
                fileNote !== null ? h('p', { role: 'status', style: STATUS(fileNote.ok) }, fileNote.text) : null,
                fileRows,
              )
            : h('div', null,
                h('div', { style: PERM_LABEL }, t.importPathLabel),
                h('textarea', {
                  value: pathInput,
                  rows: 5,
                  placeholder: t.importPathPlaceholder,
                  disabled: busy,
                  style: { ...INPUT, width: '100%', boxSizing: 'border-box', marginTop: '4px', fontSize: '12px', resize: 'vertical' },
                  'aria-label': t.importPathLabel,
                  onChange: (event) => setPathInput(event && event.target ? event.target.value : ''),
                }),
                h('p', { style: PERM_TEXT }, t.importPathHint),
              ),
        )

        // ---- 目标区（集合可直接输入新名称 / prefix） ----
        const collectionSelect = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('input', {
            type: 'text',
            list: 'corpus-import-collections',
            value: collectionDraft,
            placeholder: t.importPickCollection,
            disabled: busy,
            autoComplete: 'off',
            style: { ...INPUT, width: '100%', boxSizing: 'border-box', fontSize: '12px' },
            'aria-label': t.importCollection,
            onChange: (event) => setCollectionDraft(event && event.target ? event.target.value : ''),
          }),
          h('datalist', { id: 'corpus-import-collections' },
            collectionOptions.map((option) => h('option', {
              key: 'import-collection-' + option.name,
              value: option.name,
            }, option.docs > 0 ? option.name + ' (' + String(option.docs) + ')' : option.name)),
          ),
        )

        const targetSection = h('section', { style: PERM_SECTION },
          h('div', { style: PERM_HEAD }, h('h2', { style: PERM_H2 }, t.importTarget)),
          h('div', { style: PERM_LABEL }, t.importCollection),
          h('div', { style: PERM_FORM_ROW }, collectionSelect),
          collectionOptions.length === 0 ? h('p', { style: PERM_TEXT }, t.importNoCollections) : null,
          h('p', { style: PERM_TEXT }, t.importNewCollectionHint),
          h('p', { style: PERM_TEXT }, t.importAutoCollectionHint),
          h('div', { style: { ...PERM_LABEL, marginTop: '8px' } }, t.importPrefix),
          h('input', {
            type: 'text',
            value: prefix,
            placeholder: t.importPrefixPlaceholder,
            disabled: busy,
            style: { ...INPUT, width: '100%', boxSizing: 'border-box', marginTop: '4px', fontSize: '12px' },
            'aria-label': t.importPrefix,
            onChange: (event) => setPrefix(event && event.target ? event.target.value : ''),
          }),
        )

        // ---- 选项区（AI 开关 + 开始导入） ----
        const optionsSection = h('section', { style: PERM_SECTION },
          h('div', { style: PERM_HEAD }, h('h2', { style: PERM_H2 }, t.importOptions)),
          h('label', { style: { ...PERM_FORM_ROW, marginTop: 0, cursor: aiAvailable ? 'pointer' : 'not-allowed' } },
            h('input', {
              type: 'checkbox',
              checked: aiOn,
              disabled: busy || !aiAvailable,
              'aria-label': t.importAiTitle,
              onChange: (event) => setAiEnabled(Boolean(event && event.target ? event.target.checked : false)),
            }),
            h('span', null, t.importAiTitle),
          ),
          h('p', { style: PERM_TEXT }, t.importAiHint),
          aiAvailable ? null : h('p', {
            style: { ...PERM_TEXT, color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))' },
          }, t.importAiUnavailable),
          h('button', {
            type: 'button',
            style: { ...BTN_PRIMARY, width: '100%', marginTop: '8px' },
            disabled: busy,
            onClick: startImport,
          }, busy ? t.importRunning : t.importStart),
        )

        // ---- 进度区（轮询 /import/status） ----
        let progressSection = null
        if (activeJob !== null) {
          const current = activeJob.current !== null && activeJob.current !== undefined && typeof activeJob.current === 'object' ? activeJob.current : {}
          const stage = String(current.stage || '')
          const source = String(current.source || '')
          const done = num(activeJob.done)
          const total = num(activeJob.total)
          const failed = num(activeJob.failed)
          const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
          const itemProblems = Array.isArray(activeJob.items)
            ? activeJob.items.filter((item) => item && (item.error || item.ok === false || item.state === 'error'
                || importItemWarning(item) !== '')).slice(-3)
            : []
          progressSection = h('section', { style: PERM_SECTION },
            h('div', { style: PERM_HEAD },
              h('h2', { style: PERM_H2 }, t.importProgress),
              h('span', { style: CHIP }, t.importStage + ': ' + importStageLabel(t, stage)),
            ),
            h('p', { style: PERM_TEXT },
              t.importCounts + ': ' + String(done) + '/' + String(total)
              + ' · ' + t.importSucceeded + ' ' + String(done)
              + ' · ' + t.importFailed + ' ' + String(failed)),
            h('div', { style: PERM_PROGRESS_TRACK },
              h('div', { style: { ...PERM_PROGRESS_FILL, width: String(percent) + '%' } })),
            source !== '' ? h('p', { style: PERM_TEXT }, t.importCurrent + ': ' + source) : null,
            itemProblems.length === 0 ? null : h('ul', { style: PERM_LIST }, itemProblems.map((item, index) => h('li', {
              key: 'import-problem-' + index,
            }, (importItemProblem(item) || '—') + (item.source ? ' — ' + String(item.source) : '')))),
          )
        }

        // ---- 结果区（完成后提示成功/失败与 reindexJobId） ----
        let resultSection = null
        if (result !== null && typeof result === 'object') {
          const resultData = importResultOf(result)
          const total = num(resultData.total !== undefined ? resultData.total : result.total)
          const written = num(resultData.written !== undefined
            ? resultData.written
            : resultData.imported !== undefined
              ? resultData.imported
              : resultData.done !== undefined ? resultData.done : result.done)
          const failed = num(resultData.failed !== undefined ? resultData.failed : result.failed)
          const reindexJobId = importReindexJobId(result)
          const warnings = Array.isArray(result.items)
            ? result.items.filter((item) => item && (item.error || importItemWarning(item) !== '')).slice(-3)
            : []
          const resultErrors = Array.isArray(resultData.errors)
            ? resultData.errors.map((message) => String(message)).filter((message) => message !== '')
            : []
          resultSection = h('section', { style: PERM_SECTION },
            h('div', { style: PERM_HEAD }, h('h2', { style: PERM_H2 }, t.importResult)),
            h('p', { style: PERM_TEXT },
              t.importCounts + ': ' + String(total)
              + ' · ' + t.importSucceeded + ' ' + String(written)
              + ' · ' + t.importFailed + ' ' + String(failed)),
            reindexJobId === null ? null : h('p', { style: PERM_TEXT }, t.importReindex + ': ' + reindexJobId),
            result.state === 'error' ? h('p', { role: 'status', style: STATUS(false) }, t.importJobError + String(result.error || '')) : null,
            warnings.length === 0 ? null : h('ul', { style: PERM_LIST }, warnings.map((item, index) => h('li', {
              key: 'import-result-warning-' + index,
            }, (importItemProblem(item) || '—') + (item.source ? ' — ' + String(item.source) : '')))),
            resultErrors.length === 0 ? null : h('ul', { style: PERM_LIST }, resultErrors.map((message, index) => h('li', {
              key: 'import-result-error-' + index,
            }, message))),
          )
        }

        // ---- 支持格式 / 提取器可用性 ----
        const extractorRow = (label, available) => h('div', { style: { ...PERM_FORM_ROW, marginTop: '4px' } },
          h('span', { style: PERM_RULE_PATHS }, label),
          h('span', { style: available ? CHIP : { ...CHIP, color: 'var(--dsw-alias-state-error-primary)' } },
            available ? t.importAvailable : t.importMissing),
        )
        const pdfAvailable = extractors.pdf === true
        const officeAvailable = extractors.office === true
        const ocrAvailable = extractors.ocr === true
        const imageAvailable = extractors.image === true
        const visionAvailable = targetsData !== null && targetsData.visionAvailable === true
        const visionStatus = targetsData !== null && targetsData.visionStatus && typeof targetsData.visionStatus === 'object' ? targetsData.visionStatus : null
        const visionReason = visionStatus !== null && visionStatus.available !== true && typeof visionStatus.reason === 'string' && visionStatus.reason !== '' ? visionStatus.reason : ''
        const infoSection = h('section', { style: PERM_SECTION },
          h('div', { style: PERM_HEAD }, h('h2', { style: PERM_H2 }, t.importFormatsTitle)),
          h('div', { style: PERM_CHIPS_ROW }, formats.map((format) => h('span', {
            key: 'import-format-' + format,
            style: CHIP,
          }, format))),
          h('div', { style: { ...PERM_LABEL, marginTop: '10px', fontWeight: 600 } }, t.importExtractorsTitle),
          extractorRow('PDF', pdfAvailable),
          extractorRow('Office', officeAvailable),
          extractorRow('OCR', ocrAvailable),
          extractorRow('Vision', visionAvailable),
          pdfAvailable ? null : h('p', { style: PERM_TEXT }, t.importPdfHint),
          pdfAvailable ? h('p', { style: PERM_TEXT }, t.importPdfOcrHint) : null,
          officeAvailable ? h('p', { style: PERM_TEXT }, t.importOfficeHint) : null,
          ocrAvailable ? null : h('p', { style: PERM_TEXT }, t.importOcrHint),
          imageAvailable && visionAvailable ? null : h('p', { style: PERM_TEXT }, t.importVisionHint + (visionReason !== '' ? ' ' + t.importVisionReason + visionReason : '')),
          h('p', { style: PERM_FOOT }, t.importLimitHint(formatSize(maxUploadBytes), String(maxFiles))),
        )

        // ---- 通知区（loading/busy/error 可见） ----
        const noticeParts = []
        if (targets.loading) {
          noticeParts.push(h('p', { key: 'import-targets-loading', style: SMALL }, t.importTargetsLoading))
        }
        if (targets.error !== null) {
          noticeParts.push(h('p', { key: 'import-targets-error', role: 'status', style: STATUS(false) }, t.importTargetsFailed + targets.error))
        }
        if (jobInfo.error !== null) {
          noticeParts.push(h('p', { key: 'import-poll-error', role: 'status', style: STATUS(false) }, t.importPollFailed + jobInfo.error))
        }
        if (note !== null) {
          noticeParts.push(h('p', { key: 'import-note', role: 'status', style: STATUS(note.ok) }, note.text))
        }
        const noticeBlock = noticeParts.length === 0 ? null : h('div', { style: PERM_NOTICE }, noticeParts)

        const importGrid = { display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' }
        const importColumn = { flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '12px' }
        return h('section', { style: { ...SECTION, marginTop: '18px' } },
          h('div', { style: { ...ROW, marginBottom: '6px' } },
            h('h2', { style: { ...H2, margin: '0 auto 0 0' } }, t.importTitle),
            h('button', {
              type: 'button',
              style: BTN_GHOST,
              onClick: props && typeof props.onClose === 'function' ? props.onClose : undefined,
            }, t.importClose),
          ),
          h('p', { style: { ...SMALL, margin: '0 0 10px' } }, t.importDesc),
          noticeBlock,
          h('div', { style: importGrid },
            h('div', { style: importColumn }, sourceSection, optionsSection),
            h('div', { style: importColumn }, targetSection, progressSection, resultSection),
          ),
          infoSection,
        )
      }

      exports.inject = ['slots', 'locale', 'sidebarRightTabs']
      exports.apply = (ctx) => {
        try {
          const slots = ctx.get('slots')
          if (slots === undefined) return
          const locale = ctx.get('locale')
          let translate = (key) => {
            const dictionary = copy()
            const value = dictionary[key]
            return typeof value === 'string' ? value : key
          }
          const withLocale = {}
          if (locale !== undefined && typeof locale.register === 'function') {
            ctx.effect(() => locale.register(NS, {
              zh: {
                nav: COPY.zh.nav,
                permTitle: COPY.zh.permTitle,
                permDesc: COPY.zh.permDesc,
                previewTabTitle: COPY.zh.previewTabTitle,
                previewEmpty: COPY.zh.previewEmpty,
              },
              en: {
                nav: COPY.en.nav,
                permTitle: COPY.en.permTitle,
                permDesc: COPY.en.permDesc,
                previewTabTitle: COPY.en.previewTabTitle,
                previewEmpty: COPY.en.previewEmpty,
              },
            }), 'dsh-corpus: dictionaries')
            try {
              const bound = typeof locale.bind === 'function' ? locale.bind(NS) : null
              if (typeof bound === 'function') {
                translate = bound
                withLocale.locale = NS
              }
            } catch { /* 保持本地回退 */ }
          }

          const labelOf = (key) => {
            try {
              const value = translate(key)
              if (typeof value === 'string' && value !== '') return value
            } catch { /* 回退 */ }
            const dictionary = copy()
            return typeof dictionary[key] === 'string' ? dictionary[key] : key
          }

          // 左侧栏一行：和「插件」「自动化任务」同级（图标 + label）
          ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 46,
            label: () => labelOf('nav'),
            ...withLocale,
          }, CorpusIcon)), 'dsh-corpus: sidebar row')

          // 主区域整页：点上面那一行后显示
          ctx.effect(() => slots.inject('main', () => slots.register({
            name: 'main',
            key: PANEL_ID,
            ...withLocale,
          }, CorpusPage)), 'dsh-corpus: page')

          // 右栏「语料权限」：tab 类型 + guide（开始菜单入口）+ pane body。
          const tabs = ctx.get('sidebarRightTabs')
          let sidebarRight
          try {
            sidebarRight = ctx.get('sidebarRight')
          } catch { sidebarRight = undefined }
          permissionsOpenTab = tabs !== undefined && typeof tabs.register === 'function'
            && sidebarRight !== undefined && sidebarRight !== null && typeof sidebarRight.openTab === 'function'
            ? () => { sidebarRight.openTab('corpus-permissions'); return true }
            : null

          if (tabs !== undefined && typeof tabs.register === 'function') {
            ctx.effect(() => tabs.register({
              id: PERMISSIONS_TAB_ID,
              kind: PERMISSIONS_KIND,
              priority: 'extension',
              title: () => labelOf('permTitle'),
              guide: [{
                id: PERMISSIONS_GUIDE_ID,
                order: 55,
                title: () => labelOf('permTitle'),
                description: () => labelOf('permDesc'),
                icon: ShieldIcon,
              }],
            }), 'dsh-corpus: permissions type')
            ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
              name: 'sidebar.right.pane.tab',
              key: PERMISSIONS_TAB_ID,
            }, PermissionsPanel)), 'dsh-corpus: permissions body')
          }
        } catch (error) {
          try { console.error('[corpus] client apply failed:', error) } catch { /* 控制台不可用 */ }
        }
      }
      return module.exports
    },
  })
})()
