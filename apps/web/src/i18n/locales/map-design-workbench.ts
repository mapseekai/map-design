import type { Dict, Locale } from '../types';

type WorkbenchDict = Pick<Dict,
  | 'mapDesign.agent.mapEditingUnavailable' | 'mapDesign.agent.publicReasoningSummaryAvailable'
  | 'mapDesign.runtime.change' | 'mapDesign.runtime.settings' | 'mapDesign.runtime.settingsHint'
  | 'mapDesign.runtime.agents' | 'mapDesign.runtime.models' | 'mapDesign.runtime.searchModels'
  | 'mapDesign.runtime.customModel' | 'mapDesign.runtime.customModelPlaceholder'
  | 'mapDesign.runtime.useCustomModel'
  | 'mapDesign.runtime.reasoning' | 'mapDesign.runtime.serviceTier'
  | 'mapDesign.runtime.default'
  | 'mapDesign.runtime.agentUnavailable' | 'mapDesign.runtime.nativeToolsUnavailable'
  | 'mapDesign.runtime.policyUnsupported' | 'mapDesign.runtime.claudePolicyUnsupported'
  | 'mapDesign.runtime.catalogUnavailable' | 'mapDesign.runtime.modelUnavailable'
  | 'mapDesign.runtime.liveCatalog' | 'mapDesign.runtime.fallbackCatalog'
  | 'mapDesign.runtime.rememberedCatalog' | 'mapDesign.runtime.saving'
  | 'mapDesign.runtime.conflict' | 'mapDesign.runtime.normalized'
  | 'mapDesign.runtime.loadError' | 'mapDesign.runtime.saveError'
  | 'mapDesign.runtime.runActiveDisabled'
  | 'mapDesign.run.startError' | 'mapDesign.run.toolLoopDetected'

  | 'mapDesign.composer.label' | 'mapDesign.composer.limit'
  | 'mapDesign.composer.placeholder' | 'mapDesign.composer.runActions' | 'mapDesign.composer.send'
  | 'mapDesign.activity.working' | 'mapDesign.activity.completed'
  | 'mapDesign.activity.failed' | 'mapDesign.activity.canceled'
  | 'mapDesign.activity.stepCountOne' | 'mapDesign.activity.stepCountMany'
  | 'mapDesign.activity.expand' | 'mapDesign.activity.collapse'
  | 'mapDesign.activity.statusFallback' | 'mapDesign.activity.summaryFallback'
  | 'mapDesign.activity.toolsOmitted'
  | 'mapDesign.activity.stagePreparing' | 'mapDesign.activity.stageAnalyzing'
  | 'mapDesign.activity.stageValidating' | 'mapDesign.activity.stagePreviewing'
  | 'mapDesign.activity.stageCommitting' | 'mapDesign.activity.thinking'
  | 'mapDesign.activity.requestSummary' | 'mapDesign.activity.resultSummary'
  | 'mapDesign.activity.toolGetContext' | 'mapDesign.activity.toolInspect'
  | 'mapDesign.activity.toolSearchLayers' | 'mapDesign.activity.toolApplyTransaction'
  | 'mapDesign.activity.toolUpdateSemantics' | 'mapDesign.activity.toolValidate'
  | 'mapDesign.activity.toolRenderPreview' | 'mapDesign.activity.toolCommitRevision'
  | 'mapDesign.activity.toolDiscardDraft' | 'mapDesign.activity.toolGeneric'
  | 'mapDesign.activity.toolsOmittedCount' | 'mapDesign.activity.toolsOmittedFailures'
  | 'mapDesign.conversation.cancelRun' | 'mapDesign.conversation.chatRegion'
  | 'mapDesign.conversation.collapse' | 'mapDesign.conversation.createError'
  | 'mapDesign.conversation.creating' | 'mapDesign.conversation.creatingStatus'
  | 'mapDesign.conversation.defaultTitle' | 'mapDesign.conversation.expand'
  | 'mapDesign.conversation.listError' | 'mapDesign.conversation.listLabel'
  | 'mapDesign.conversation.loadError' | 'mapDesign.conversation.loading'
  | 'mapDesign.conversation.messageCountMany' | 'mapDesign.conversation.messageCountOne'
  | 'mapDesign.conversation.none'
  | 'mapDesign.conversation.railCollapsed' | 'mapDesign.conversation.resize'
  | 'mapDesign.conversation.retry' | 'mapDesign.conversation.runActive'
  | 'mapDesign.conversation.running' | 'mapDesign.conversation.unavailableNotice'
  | 'mapDesign.workspace.agentUnavailable' | 'mapDesign.workspace.importFailed'
  | 'mapDesign.workspace.importing' | 'mapDesign.workspace.loadError'
  | 'mapDesign.workspace.loading' | 'mapDesign.workspace.openSettings'
  | 'mapDesign.workspace.retryImport' | 'mapDesign.workspace.unavailableProject'
  | 'mapDesign.studio.mapNavigation' | 'mapDesign.studio.zoomIn'
  | 'mapDesign.studio.zoomOut' | 'mapDesign.studio.locate'
  | 'mapDesign.studio.resetNorth' | 'mapDesign.studio.locationUnavailable'
  | 'mapDesign.studio.locationPending' | 'mapDesign.studio.locationSuccess'
  | 'mapDesign.studio.locationError'
  | 'mapDesign.revision.banner' | 'mapDesign.revision.cancel'
  | 'mapDesign.revision.composerReadOnly' | 'mapDesign.revision.currentCommit'
  | 'mapDesign.revision.historyPreserved' | 'mapDesign.revision.historicalUnavailable'
  | 'mapDesign.revision.restore' | 'mapDesign.revision.restoreActiveRun'
  | 'mapDesign.revision.restoreConflict'
  | 'mapDesign.revision.restoreDescription' | 'mapDesign.revision.restoreFailed'
  | 'mapDesign.revision.restoreSuccess' | 'mapDesign.revision.restoreTitle'
  | 'mapDesign.revision.restoring' | 'mapDesign.revision.returnCurrent'
  | 'mapDesign.revision.view' | 'mapDesign.revision.viewing'
>;

type ComposerCopy = readonly [string, string, string, string, string, string, string];
type ActivityCopy = readonly [
  string, string, string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string, string, string,
  string,
];
type ConversationCopy = readonly [
  string, string, string, string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string, string, string, string,
];
type WorkspaceCopy = readonly [string, string, string, string, string, string, string, string];
type NavigationCopy = readonly [string, string, string, string, string, string, string, string, string];
type AgentCopy = readonly [string, string];
type Copy = { agent: AgentCopy; composer: ComposerCopy; activity: ActivityCopy; conversation: ConversationCopy; workspace: WorkspaceCopy; navigation: NavigationCopy };
type RevisionCopy = readonly [
  string, string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string,
];
type RuntimeCopy = readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string,
];

const runtimeCopy = {
  en: [
    'Change runtime', 'Runtime settings', 'Live choices are saved to this conversation.', 'Agents', 'Models', 'Search models', 'Reasoning', 'Service tier',
    'This Agent is not installed or unavailable.', 'Native map editing tools are unavailable for this Agent.', 'This Agent policy does not allow MapDesign MCP tools.', 'Claude Code policy does not allow MapDesign MCP tools.', 'This Agent model catalog is unavailable.', 'This model is unavailable.', 'Live model catalog', 'Fallback model catalog', 'Last known model catalog', 'Saving runtime…', 'The conversation runtime changed in another client. The latest choice is shown.', 'The daemon adjusted this runtime to an available Agent or model.', 'The conversation runtime could not be loaded.', 'The conversation runtime could not be saved.', 'Runtime cannot change while a run is active.',
  ],
  id: [
    'Ubah runtime', 'Pengaturan runtime', 'Pilihan langsung disimpan ke percakapan ini.', 'Agen', 'Model', 'Cari model', 'Penalaran', 'Tingkat layanan',
    'Agen ini tidak terpasang atau tidak tersedia.', 'Alat pengeditan peta native tidak tersedia untuk Agen ini.', 'Kebijakan Agen ini tidak mengizinkan alat MCP MapDesign.', 'Kebijakan Claude Code tidak mengizinkan alat MCP MapDesign.', 'Katalog model Agen ini tidak tersedia.', 'Model ini tidak tersedia.', 'Katalog model langsung', 'Katalog model cadangan', 'Katalog model terakhir', 'Menyimpan runtime…', 'Runtime percakapan berubah di klien lain. Pilihan terbaru ditampilkan.', 'Daemon menyesuaikan runtime ini ke Agen atau model yang tersedia.', 'Runtime percakapan tidak dapat dimuat.', 'Runtime percakapan tidak dapat disimpan.', 'Runtime tidak dapat diubah saat proses aktif.',
  ],
  de: [
    'Runtime ändern', 'Runtime-Einstellungen', 'Live-Auswahlen werden in dieser Unterhaltung gespeichert.', 'Agenten', 'Modelle', 'Modelle suchen', 'Reasoning', 'Dienststufe',
    'Dieser Agent ist nicht installiert oder nicht verfügbar.', 'Native Kartenwerkzeuge sind für diesen Agenten nicht verfügbar.', 'Die Richtlinie dieses Agenten erlaubt keine MapDesign-MCP-Werkzeuge.', 'Die Claude-Code-Richtlinie erlaubt keine MapDesign-MCP-Werkzeuge.', 'Der Modellkatalog dieses Agenten ist nicht verfügbar.', 'Dieses Modell ist nicht verfügbar.', 'Live-Modellkatalog', 'Fallback-Modellkatalog', 'Zuletzt bekannter Modellkatalog', 'Runtime wird gespeichert…', 'Die Runtime wurde in einem anderen Client geändert. Die neueste Auswahl wird angezeigt.', 'Der Daemon hat diese Runtime auf einen verfügbaren Agenten oder ein verfügbares Modell angepasst.', 'Die Runtime konnte nicht geladen werden.', 'Die Runtime konnte nicht gespeichert werden.', 'Während einer aktiven Ausführung kann die Runtime nicht geändert werden.',
  ],
  'zh-CN': [
    '更改运行时', '运行时设置', '当前选择会保存到此对话。', '智能体', '模型', '搜索模型', '推理强度', '服务层级',
    '此智能体未安装或不可用。', '此智能体不支持原生地图编辑工具。', '此智能体的策略不允许使用 MapDesign MCP 工具。', 'Claude Code 的策略不允许使用 MapDesign MCP 工具。', '此智能体的模型目录不可用。', '此模型不可用。', '实时模型目录', '备用模型目录', '上次可用的模型目录', '正在保存运行时…', '其他客户端已更改对话运行时，现已显示最新选择。', '守护进程已将运行时调整为可用的智能体或模型。', '无法加载对话运行时。', '无法保存对话运行时。', '运行期间无法更改运行时。',
  ],
  'zh-TW': [
    '變更執行環境', '執行環境設定', '目前選擇會儲存到此對話。', '代理程式', '模型', '搜尋模型', '推理強度', '服務層級',
    '此代理程式未安裝或無法使用。', '此代理程式不支援原生地圖編輯工具。', '此代理程式的政策不允許使用 MapDesign MCP 工具。', 'Claude Code 的政策不允許使用 MapDesign MCP 工具。', '此代理程式的模型目錄無法使用。', '此模型無法使用。', '即時模型目錄', '備用模型目錄', '上次可用的模型目錄', '正在儲存執行環境…', '其他用戶端已變更對話執行環境，現已顯示最新選擇。', '常駐程式已將執行環境調整為可用的代理程式或模型。', '無法載入對話執行環境。', '無法儲存對話執行環境。', '執行期間無法變更執行環境。',
  ],
  'pt-BR': [
    'Alterar runtime', 'Configurações de runtime', 'As escolhas atuais são salvas nesta conversa.', 'Agentes', 'Modelos', 'Pesquisar modelos', 'Raciocínio', 'Nível de serviço',
    'Este Agente não está instalado ou disponível.', 'As ferramentas nativas de edição de mapas não estão disponíveis para este Agente.', 'A política deste Agente não permite ferramentas MCP do MapDesign.', 'A política do Claude Code não permite ferramentas MCP do MapDesign.', 'O catálogo de modelos deste Agente não está disponível.', 'Este modelo não está disponível.', 'Catálogo de modelos ao vivo', 'Catálogo de modelos alternativo', 'Último catálogo de modelos conhecido', 'Salvando runtime…', 'O runtime da conversa mudou em outro cliente. A escolha mais recente é exibida.', 'O daemon ajustou este runtime para um Agente ou modelo disponível.', 'Não foi possível carregar o runtime da conversa.', 'Não foi possível salvar o runtime da conversa.', 'O runtime não pode ser alterado durante uma execução ativa.',
  ],
  'es-ES': [
    'Cambiar entorno', 'Configuración del entorno', 'Las opciones actuales se guardan en esta conversación.', 'Agentes', 'Modelos', 'Buscar modelos', 'Razonamiento', 'Nivel de servicio',
    'Este Agente no está instalado o disponible.', 'Las herramientas nativas de edición de mapas no están disponibles para este Agente.', 'La política de este Agente no permite herramientas MCP de MapDesign.', 'La política de Claude Code no permite herramientas MCP de MapDesign.', 'El catálogo de modelos de este Agente no está disponible.', 'Este modelo no está disponible.', 'Catálogo de modelos en directo', 'Catálogo de modelos alternativo', 'Último catálogo de modelos conocido', 'Guardando entorno…', 'El entorno de la conversación cambió en otro cliente. Se muestra la opción más reciente.', 'El daemon ajustó este entorno a un Agente o modelo disponible.', 'No se pudo cargar el entorno de la conversación.', 'No se pudo guardar el entorno de la conversación.', 'El entorno no se puede cambiar mientras hay una ejecución activa.',
  ],
  ru: [
    'Изменить среду', 'Настройки среды', 'Текущий выбор сохраняется в этом диалоге.', 'Агенты', 'Модели', 'Поиск моделей', 'Рассуждение', 'Уровень сервиса',
    'Этот агент не установлен или недоступен.', 'Нативные инструменты редактирования карты недоступны для этого агента.', 'Политика этого агента не разрешает инструменты MapDesign MCP.', 'Политика Claude Code не разрешает инструменты MapDesign MCP.', 'Каталог моделей этого агента недоступен.', 'Эта модель недоступна.', 'Актуальный каталог моделей', 'Резервный каталог моделей', 'Последний известный каталог моделей', 'Сохранение среды…', 'Среда диалога изменена в другом клиенте. Показан последний выбор.', 'Служба скорректировала среду на доступного агента или модель.', 'Не удалось загрузить среду диалога.', 'Не удалось сохранить среду диалога.', 'Нельзя менять среду во время активного выполнения.',
  ],
  fa: [
    'تغییر محیط اجرا', 'تنظیمات محیط اجرا', 'انتخاب‌های جاری در این گفتگو ذخیره می‌شوند.', 'عامل‌ها', 'مدل‌ها', 'جستجوی مدل', 'استدلال', 'سطح خدمت',
    'این عامل نصب نیست یا در دسترس نیست.', 'ابزارهای بومی ویرایش نقشه برای این عامل در دسترس نیستند.', 'سیاست این عامل ابزارهای MCP‏ MapDesign را مجاز نمی‌داند.', 'سیاست Claude Code ابزارهای MCP‏ MapDesign را مجاز نمی‌داند.', 'فهرست مدل‌های این عامل در دسترس نیست.', 'این مدل در دسترس نیست.', 'فهرست زنده مدل‌ها', 'فهرست پشتیبان مدل‌ها', 'آخرین فهرست شناخته‌شده مدل‌ها', 'در حال ذخیره محیط اجرا…', 'محیط اجرای گفتگو در کارخواه دیگری تغییر کرد. تازه‌ترین انتخاب نمایش داده می‌شود.', 'سرویس محیط اجرا را به عامل یا مدل در دسترس تنظیم کرد.', 'محیط اجرای گفتگو بارگیری نشد.', 'محیط اجرای گفتگو ذخیره نشد.', 'هنگام اجرای فعال نمی‌توان محیط اجرا را تغییر داد.',
  ],
  ar: [
    'تغيير بيئة التشغيل', 'إعدادات بيئة التشغيل', 'تُحفظ الخيارات الحالية في هذه المحادثة.', 'الوكلاء', 'النماذج', 'البحث في النماذج', 'الاستدلال', 'مستوى الخدمة',
    'هذا الوكيل غير مثبت أو غير متاح.', 'أدوات تحرير الخرائط الأصلية غير متاحة لهذا الوكيل.', 'سياسة هذا الوكيل لا تسمح بأدوات MapDesign MCP.', 'سياسة Claude Code لا تسمح بأدوات MapDesign MCP.', 'دليل نماذج هذا الوكيل غير متاح.', 'هذا النموذج غير متاح.', 'دليل النماذج المباشر', 'دليل النماذج الاحتياطي', 'آخر دليل نماذج معروف', 'جارٍ حفظ بيئة التشغيل…', 'تغيرت بيئة تشغيل المحادثة في عميل آخر. يظهر أحدث اختيار.', 'عدّلت الخدمة بيئة التشغيل إلى وكيل أو نموذج متاح.', 'تعذر تحميل بيئة تشغيل المحادثة.', 'تعذر حفظ بيئة تشغيل المحادثة.', 'لا يمكن تغيير بيئة التشغيل أثناء تشغيل نشط.',
  ],
  ja: [
    'ランタイムを変更', 'ランタイム設定', '現在の選択はこの会話に保存されます。', 'エージェント', 'モデル', 'モデルを検索', '推論', 'サービス階層',
    'このエージェントは未インストールか利用できません。', 'このエージェントではネイティブ地図編集ツールを利用できません。', 'このエージェントのポリシーでは MapDesign MCP ツールを使用できません。', 'Claude Code のポリシーでは MapDesign MCP ツールを使用できません。', 'このエージェントのモデルカタログを利用できません。', 'このモデルは利用できません。', 'ライブモデルカタログ', 'フォールバックモデルカタログ', '前回のモデルカタログ', 'ランタイムを保存中…', '別のクライアントで会話のランタイムが変更されました。最新の選択を表示しています。', 'デーモンが利用可能なエージェントまたはモデルに調整しました。', '会話のランタイムを読み込めませんでした。', '会話のランタイムを保存できませんでした。', '実行中はランタイムを変更できません。',
  ],
  ko: [
    '런타임 변경', '런타임 설정', '현재 선택은 이 대화에 저장됩니다.', '에이전트', '모델', '모델 검색', '추론', '서비스 등급',
    '이 에이전트가 설치되지 않았거나 사용할 수 없습니다.', '이 에이전트에서는 네이티브 지도 편집 도구를 사용할 수 없습니다.', '이 에이전트 정책은 MapDesign MCP 도구를 허용하지 않습니다.', 'Claude Code 정책은 MapDesign MCP 도구를 허용하지 않습니다.', '이 에이전트의 모델 카탈로그를 사용할 수 없습니다.', '이 모델을 사용할 수 없습니다.', '실시간 모델 카탈로그', '대체 모델 카탈로그', '마지막 모델 카탈로그', '런타임 저장 중…', '다른 클라이언트에서 대화 런타임이 변경되었습니다. 최신 선택을 표시합니다.', '데몬이 사용 가능한 에이전트 또는 모델로 런타임을 조정했습니다.', '대화 런타임을 불러올 수 없습니다.', '대화 런타임을 저장할 수 없습니다.', '실행 중에는 런타임을 변경할 수 없습니다.',
  ],
  pl: [
    'Zmień środowisko', 'Ustawienia środowiska', 'Bieżące wybory są zapisywane w tej rozmowie.', 'Agenci', 'Modele', 'Szukaj modeli', 'Rozumowanie', 'Poziom usługi',
    'Ten Agent nie jest zainstalowany lub dostępny.', 'Natywne narzędzia edycji map nie są dostępne dla tego Agenta.', 'Zasady tego Agenta nie zezwalają na narzędzia MapDesign MCP.', 'Zasady Claude Code nie zezwalają na narzędzia MapDesign MCP.', 'Katalog modeli tego Agenta jest niedostępny.', 'Ten model jest niedostępny.', 'Aktualny katalog modeli', 'Zapasowy katalog modeli', 'Ostatni znany katalog modeli', 'Zapisywanie środowiska…', 'Środowisko rozmowy zmieniło się w innym kliencie. Pokazano najnowszy wybór.', 'Demon dostosował środowisko do dostępnego Agenta lub modelu.', 'Nie udało się wczytać środowiska rozmowy.', 'Nie udało się zapisać środowiska rozmowy.', 'Nie można zmienić środowiska podczas aktywnego wykonania.',
  ],
  hu: [
    'Futtatókörnyezet módosítása', 'Futtatókörnyezet beállításai', 'Az aktuális választás ebbe a beszélgetésbe mentődik.', 'Ügynökök', 'Modellek', 'Modellek keresése', 'Érvelés', 'Szolgáltatási szint',
    'Ez az ügynök nincs telepítve vagy nem érhető el.', 'A natív térképszerkesztő eszközök nem érhetők el ennél az ügynöknél.', 'Az ügynök szabályzata nem engedélyezi a MapDesign MCP-eszközöket.', 'A Claude Code szabályzata nem engedélyezi a MapDesign MCP-eszközöket.', 'Az ügynök modellkatalógusa nem érhető el.', 'Ez a modell nem érhető el.', 'Élő modellkatalógus', 'Tartalék modellkatalógus', 'Legutóbbi ismert modellkatalógus', 'Futtatókörnyezet mentése…', 'A beszélgetés futtatókörnyezete egy másik kliensben megváltozott. A legújabb választás látható.', 'A démon elérhető ügynökre vagy modellre módosította a futtatókörnyezetet.', 'A beszélgetés futtatókörnyezete nem tölthető be.', 'A beszélgetés futtatókörnyezete nem menthető.', 'Aktív futás közben a futtatókörnyezet nem módosítható.',
  ],
  fr: [
    'Changer l’environnement', 'Paramètres d’exécution', 'Les choix actuels sont enregistrés dans cette conversation.', 'Agents', 'Modèles', 'Rechercher des modèles', 'Raisonnement', 'Niveau de service',
    'Cet Agent n’est pas installé ou disponible.', 'Les outils natifs de modification de carte ne sont pas disponibles pour cet Agent.', 'La politique de cet Agent n’autorise pas les outils MCP MapDesign.', 'La politique de Claude Code n’autorise pas les outils MCP MapDesign.', 'Le catalogue de modèles de cet Agent est indisponible.', 'Ce modèle est indisponible.', 'Catalogue de modèles en direct', 'Catalogue de modèles de secours', 'Dernier catalogue de modèles connu', 'Enregistrement de l’environnement…', 'L’environnement de la conversation a changé dans un autre client. Le dernier choix est affiché.', 'Le daemon a ajusté l’environnement vers un Agent ou modèle disponible.', 'Impossible de charger l’environnement de la conversation.', 'Impossible d’enregistrer l’environnement de la conversation.', 'L’environnement ne peut pas être modifié pendant une exécution active.',
  ],
  uk: [
    'Змінити середовище', 'Налаштування середовища', 'Поточний вибір зберігається в цій розмові.', 'Агенти', 'Моделі', 'Пошук моделей', 'Міркування', 'Рівень сервісу',
    'Цей агент не встановлений або недоступний.', 'Власні інструменти редагування карти недоступні для цього агента.', 'Політика цього агента не дозволяє інструменти MapDesign MCP.', 'Політика Claude Code не дозволяє інструменти MapDesign MCP.', 'Каталог моделей цього агента недоступний.', 'Ця модель недоступна.', 'Актуальний каталог моделей', 'Резервний каталог моделей', 'Останній відомий каталог моделей', 'Збереження середовища…', 'Середовище розмови змінено в іншому клієнті. Показано останній вибір.', 'Служба скоригувала середовище на доступного агента або модель.', 'Не вдалося завантажити середовище розмови.', 'Не вдалося зберегти середовище розмови.', 'Не можна змінювати середовище під час активного виконання.',
  ],
  tr: [
    'Çalışma ortamını değiştir', 'Çalışma ortamı ayarları', 'Geçerli seçimler bu konuşmaya kaydedilir.', 'Ajanlar', 'Modeller', 'Model ara', 'Akıl yürütme', 'Hizmet katmanı',
    'Bu Ajan yüklü değil veya kullanılamıyor.', 'Yerel harita düzenleme araçları bu Ajan için kullanılamıyor.', 'Bu Ajanın politikası MapDesign MCP araçlarına izin vermiyor.', 'Claude Code politikası MapDesign MCP araçlarına izin vermiyor.', 'Bu Ajanın model kataloğu kullanılamıyor.', 'Bu model kullanılamıyor.', 'Canlı model kataloğu', 'Yedek model kataloğu', 'Son bilinen model kataloğu', 'Çalışma ortamı kaydediliyor…', 'Konuşma çalışma ortamı başka bir istemcide değişti. En son seçim gösteriliyor.', 'Arka plan hizmeti çalışma ortamını kullanılabilir bir Ajan veya modele ayarladı.', 'Konuşma çalışma ortamı yüklenemedi.', 'Konuşma çalışma ortamı kaydedilemedi.', 'Etkin bir çalışma sırasında ortam değiştirilemez.',
  ],
  th: [
    'เปลี่ยนรันไทม์', 'การตั้งค่ารันไทม์', 'ตัวเลือกปัจจุบันจะบันทึกในบทสนทนานี้', 'เอเจนต์', 'โมเดล', 'ค้นหาโมเดล', 'การให้เหตุผล', 'ระดับบริการ',
    'เอเจนต์นี้ไม่ได้ติดตั้งหรือไม่พร้อมใช้งาน', 'เครื่องมือแก้ไขแผนที่แบบเนทีฟไม่พร้อมใช้งานสำหรับเอเจนต์นี้', 'นโยบายของเอเจนต์นี้ไม่อนุญาตเครื่องมือ MapDesign MCP', 'นโยบาย Claude Code ไม่อนุญาตเครื่องมือ MapDesign MCP', 'แค็ตตาล็อกโมเดลของเอเจนต์นี้ไม่พร้อมใช้งาน', 'โมเดลนี้ไม่พร้อมใช้งาน', 'แค็ตตาล็อกโมเดลสด', 'แค็ตตาล็อกโมเดลสำรอง', 'แค็ตตาล็อกโมเดลล่าสุด', 'กำลังบันทึกรันไทม์…', 'รันไทม์ของบทสนทนาเปลี่ยนในไคลเอนต์อื่น แสดงตัวเลือกล่าสุดแล้ว', 'บริการปรับรันไทม์เป็นเอเจนต์หรือโมเดลที่พร้อมใช้งาน', 'โหลดรันไทม์ของบทสนทนาไม่ได้', 'บันทึกรันไทม์ของบทสนทนาไม่ได้', 'เปลี่ยนรันไทม์ไม่ได้ขณะมีการทำงานอยู่',
  ],
  it: [
    'Cambia runtime', 'Impostazioni runtime', 'Le scelte correnti vengono salvate in questa conversazione.', 'Agenti', 'Modelli', 'Cerca modelli', 'Ragionamento', 'Livello di servizio',
    'Questo Agente non è installato o disponibile.', 'Gli strumenti nativi di modifica delle mappe non sono disponibili per questo Agente.', 'La politica di questo Agente non consente gli strumenti MCP MapDesign.', 'La politica di Claude Code non consente gli strumenti MCP MapDesign.', 'Il catalogo modelli di questo Agente non è disponibile.', 'Questo modello non è disponibile.', 'Catalogo modelli live', 'Catalogo modelli alternativo', 'Ultimo catalogo modelli noto', 'Salvataggio runtime…', 'Il runtime della conversazione è cambiato in un altro client. Viene mostrata la scelta più recente.', 'Il daemon ha adattato il runtime a un Agente o modello disponibile.', 'Impossibile caricare il runtime della conversazione.', 'Impossibile salvare il runtime della conversazione.', 'Il runtime non può essere modificato durante un’esecuzione attiva.',
  ],
} satisfies Record<Locale, RuntimeCopy>;

const runtimeDefaultCopy = {
  en: 'Default', id: 'Bawaan', de: 'Standard', 'zh-CN': '默认', 'zh-TW': '預設',
  'pt-BR': 'Padrão', 'es-ES': 'Predeterminado', ru: 'По умолчанию', fa: 'پیش‌فرض', ar: 'افتراضي',
  ja: 'デフォルト', ko: '기본값', pl: 'Domyślne', hu: 'Alapértelmezett', fr: 'Par défaut',
  uk: 'За замовчуванням', tr: 'Varsayılan', th: 'ค่าเริ่มต้น', it: 'Predefinito',
} satisfies Record<Locale, string>;

const runtimeCustomModelCopy = {
  en: ['Custom model', 'provider/model identifier', 'Use custom model'],
  id: ['Model kustom', 'ID penyedia/model', 'Gunakan model kustom'],
  de: ['Benutzerdefiniertes Modell', 'Anbieter-/Modellkennung', 'Benutzerdefiniertes Modell verwenden'],
  'zh-CN': ['自定义模型', '提供商/模型标识符', '使用自定义模型'],
  'zh-TW': ['自訂模型', '提供者/模型識別碼', '使用自訂模型'],
  'pt-BR': ['Modelo personalizado', 'Identificador provedor/modelo', 'Usar modelo personalizado'],
  'es-ES': ['Modelo personalizado', 'Identificador proveedor/modelo', 'Usar modelo personalizado'],
  ru: ['Пользовательская модель', 'Идентификатор провайдер/модель', 'Использовать модель'],
  fa: ['مدل سفارشی', 'شناسهٔ ارائه‌دهنده/مدل', 'استفاده از مدل سفارشی'],
  ar: ['نموذج مخصص', 'معرّف المزوّد/النموذج', 'استخدام نموذج مخصص'],
  ja: ['カスタムモデル', 'プロバイダー/モデル識別子', 'カスタムモデルを使用'],
  ko: ['사용자 지정 모델', '공급자/모델 식별자', '사용자 지정 모델 사용'],
  pl: ['Model niestandardowy', 'Identyfikator dostawca/model', 'Użyj modelu niestandardowego'],
  hu: ['Egyéni modell', 'Szolgáltató/modell azonosító', 'Egyéni modell használata'],
  fr: ['Modèle personnalisé', 'Identifiant fournisseur/modèle', 'Utiliser le modèle personnalisé'],
  uk: ['Власна модель', 'Ідентифікатор постачальник/модель', 'Використати власну модель'],
  tr: ['Özel model', 'Sağlayıcı/model kimliği', 'Özel modeli kullan'],
  th: ['โมเดลกำหนดเอง', 'รหัสผู้ให้บริการ/โมเดล', 'ใช้โมเดลกำหนดเอง'],
  it: ['Modello personalizzato', 'Identificatore provider/modello', 'Usa modello personalizzato'],
} satisfies Record<Locale, readonly [string, string, string]>;

const runStartError = {
  en: 'The map run could not be started.',
  id: 'Proses peta tidak dapat dimulai.',
  de: 'Die Kartenausführung konnte nicht gestartet werden.',
  'zh-CN': '无法启动地图运行。',
  'zh-TW': '無法啟動地圖執行。',
  'pt-BR': 'Não foi possível iniciar a execução do mapa.',
  'es-ES': 'No se pudo iniciar la ejecución del mapa.',
  ru: 'Не удалось запустить обработку карты.',
  fa: 'اجرای نقشه آغاز نشد.',
  ar: 'تعذر بدء تشغيل الخريطة.',
  ja: 'マップ実行を開始できませんでした。',
  ko: '지도 실행을 시작할 수 없습니다.',
  pl: 'Nie udało się uruchomić zadania mapy.',
  hu: 'A térképfuttatás nem indítható el.',
  fr: 'Impossible de démarrer l’exécution de la carte.',
  uk: 'Не вдалося запустити виконання карти.',
  tr: 'Harita çalıştırması başlatılamadı.',
  th: 'ไม่สามารถเริ่มการทำงานของแผนที่ได้',
  it: 'Impossibile avviare l’esecuzione della mappa.',
} satisfies Record<Locale, string>;

const runToolLoopDetected = {
  en: 'Repeated invalid map tool calls were stopped.',
  id: 'Panggilan alat peta tidak valid yang berulang dihentikan.',
  de: 'Wiederholte ungültige Kartenwerkzeugaufrufe wurden gestoppt.',
  'zh-CN': '已停止重复的无效地图工具调用。',
  'zh-TW': '已停止重複的無效地圖工具呼叫。',
  'pt-BR': 'Chamadas inválidas repetidas da ferramenta de mapa foram interrompidas.',
  'es-ES': 'Se detuvieron las llamadas repetidas no válidas a herramientas de mapas.',
  ru: 'Повторяющиеся недопустимые вызовы инструментов карты были остановлены.',
  fa: 'فراخوانی‌های تکراری و نامعتبر ابزار نقشه متوقف شدند.',
  ar: 'تم إيقاف استدعاءات أدوات الخريطة غير الصالحة والمتكررة.',
  ja: '無効なマップツール呼び出しの繰り返しを停止しました。',
  ko: '반복되는 잘못된 지도 도구 호출을 중지했습니다.',
  pl: 'Zatrzymano powtarzające się nieprawidłowe wywołania narzędzi mapy.',
  hu: 'A rendszer leállította az ismétlődő, érvénytelen térképeszköz-hívásokat.',
  fr: 'Les appels répétés non valides aux outils cartographiques ont été arrêtés.',
  uk: 'Повторювані недійсні виклики інструментів карти зупинено.',
  tr: 'Yinelenen geçersiz harita aracı çağrıları durduruldu.',
  th: 'หยุดการเรียกใช้เครื่องมือแผนที่ที่ไม่ถูกต้องซ้ำแล้ว',
  it: 'Le chiamate ripetute non valide agli strumenti della mappa sono state interrotte.',
} satisfies Record<Locale, string>;

const restoreActiveRun = {
  en: 'A map run is active. Wait for it to finish or cancel it, then try restoring again.',
  id: 'Proses peta sedang aktif. Tunggu hingga selesai atau batalkan, lalu coba pulihkan lagi.',
  de: 'Eine Kartenausführung ist aktiv. Warten Sie, bis sie beendet ist, oder brechen Sie sie ab und versuchen Sie die Wiederherstellung erneut.',
  'zh-CN': '地图运行正在进行中。请等待其完成或将其取消，然后再次尝试恢复。',
  'zh-TW': '地圖執行正在進行中。請等待其完成或將其取消，然後再次嘗試還原。',
  'pt-BR': 'Há uma execução de mapa ativa. Aguarde a conclusão ou cancele-a e tente restaurar novamente.',
  'es-ES': 'Hay una ejecución de mapa activa. Espera a que termine o cancélala y vuelve a intentar la restauración.',
  ru: 'Выполняется обработка карты. Дождитесь её завершения или отмените её, затем повторите восстановление.',
  fa: 'یک اجرای نقشه فعال است. صبر کنید تمام شود یا آن را لغو کنید، سپس دوباره بازیابی را امتحان کنید.',
  ar: 'هناك تشغيل نشط للخريطة. انتظر حتى ينتهي أو ألغِه، ثم حاول الاستعادة مرة أخرى.',
  ja: 'マップ実行が進行中です。完了を待つかキャンセルしてから、もう一度復元してください。',
  ko: '지도 실행이 진행 중입니다. 완료될 때까지 기다리거나 취소한 후 다시 복원하세요.',
  pl: 'Trwa zadanie mapy. Poczekaj na jego zakończenie lub je anuluj, a następnie ponów przywracanie.',
  hu: 'Egy térképfuttatás aktív. Várja meg, amíg befejeződik, vagy szakítsa meg, majd próbálja újra a visszaállítást.',
  fr: 'Une exécution de carte est active. Attendez sa fin ou annulez-la, puis réessayez la restauration.',
  uk: 'Виконується завдання карти. Дочекайтеся його завершення або скасуйте його, а потім повторіть відновлення.',
  tr: 'Bir harita çalıştırması etkin. Tamamlanmasını bekleyin veya iptal edin, ardından geri yüklemeyi yeniden deneyin.',
  th: 'มีการทำงานของแผนที่อยู่ โปรดรอให้เสร็จหรือยกเลิก แล้วลองกู้คืนอีกครั้ง',
  it: 'È in corso un’esecuzione della mappa. Attendi che termini o annullala, quindi riprova il ripristino.',
} satisfies Record<Locale, string>;

const revisionCopy = {
  en: ['Viewing revision {revision} · Read only', 'Cancel', 'Return to current version to edit this historical revision.', 'Current commit', 'Committed history will stay unchanged.', 'This historical version is unavailable.', 'Restore as new draft', 'The current draft changed. Reloaded the latest context; confirm restore again.', 'Revision {revision} will replace current draft revision {draftRevision}.', 'Could not restore revision {revision}. Try again.', 'Restored revision {revision} as new draft revision {draftRevision}.', 'Restore revision {revision} as a new draft?', 'Restoring draft…', 'Return to current version', 'View revision {revision}', 'Viewing'],
  id: ['Melihat revisi {revision} · Hanya baca', 'Batal', 'Kembali ke versi saat ini untuk mengedit revisi historis ini.', 'Komit saat ini', 'Riwayat yang telah dikomit tidak akan berubah.', 'Versi historis ini tidak tersedia.', 'Pulihkan sebagai draf baru', 'Draf saat ini berubah. Konteks terbaru telah dimuat ulang; konfirmasi pemulihan lagi.', 'Revisi {revision} akan menggantikan draf saat ini revisi {draftRevision}.', 'Tidak dapat memulihkan revisi {revision}. Coba lagi.', 'Revisi {revision} dipulihkan sebagai draf baru revisi {draftRevision}.', 'Pulihkan revisi {revision} sebagai draf baru?', 'Memulihkan draf…', 'Kembali ke versi saat ini', 'Lihat revisi {revision}', 'Sedang dilihat'],
  de: ['Revision {revision} wird angezeigt · Schreibgeschützt', 'Abbrechen', 'Kehren Sie zur aktuellen Version zurück, um diese historische Revision zu bearbeiten.', 'Aktueller Commit', 'Der Commit-Verlauf bleibt unverändert.', 'Diese historische Version ist nicht verfügbar.', 'Als neuen Entwurf wiederherstellen', 'Der aktuelle Entwurf wurde geändert. Der neueste Kontext wurde geladen; bestätigen Sie die Wiederherstellung erneut.', 'Revision {revision} ersetzt den aktuellen Entwurf Revision {draftRevision}.', 'Revision {revision} konnte nicht wiederhergestellt werden. Versuchen Sie es erneut.', 'Revision {revision} wurde als neuer Entwurf Revision {draftRevision} wiederhergestellt.', 'Revision {revision} als neuen Entwurf wiederherstellen?', 'Entwurf wird wiederhergestellt…', 'Zur aktuellen Version zurückkehren', 'Revision {revision} anzeigen', 'Wird angezeigt'],
  'zh-CN': ['正在查看修订版本 {revision} · 只读', '取消', '请返回当前版本以编辑此历史修订版本。', '当前提交', '已提交的历史记录不会更改。', '此历史版本不可用。', '恢复为新草稿', '当前草稿已更改。已重新加载最新上下文；请再次确认恢复。', '修订版本 {revision} 将替换当前草稿修订版本 {draftRevision}。', '无法恢复修订版本 {revision}。请重试。', '已将修订版本 {revision} 恢复为新草稿修订版本 {draftRevision}。', '要将修订版本 {revision} 恢复为新草稿吗？', '正在恢复草稿…', '返回当前版本', '查看修订版本 {revision}', '正在查看'],
  'zh-TW': ['正在檢視修訂版本 {revision} · 唯讀', '取消', '請返回目前版本以編輯此歷史修訂版本。', '目前提交', '已提交的歷史記錄不會變更。', '此歷史版本無法使用。', '還原為新草稿', '目前草稿已變更。已重新載入最新內容；請再次確認還原。', '修訂版本 {revision} 將取代目前草稿修訂版本 {draftRevision}。', '無法還原修訂版本 {revision}。請再試一次。', '已將修訂版本 {revision} 還原為新草稿修訂版本 {draftRevision}。', '要將修訂版本 {revision} 還原為新草稿嗎？', '正在還原草稿…', '返回目前版本', '檢視修訂版本 {revision}', '正在檢視'],
  'pt-BR': ['Visualizando a revisão {revision} · Somente leitura', 'Cancelar', 'Volte à versão atual para editar esta revisão histórica.', 'Commit atual', 'O histórico confirmado permanecerá inalterado.', 'Esta versão histórica não está disponível.', 'Restaurar como novo rascunho', 'O rascunho atual mudou. O contexto mais recente foi recarregado; confirme a restauração novamente.', 'A revisão {revision} substituirá o rascunho atual revisão {draftRevision}.', 'Não foi possível restaurar a revisão {revision}. Tente novamente.', 'A revisão {revision} foi restaurada como novo rascunho revisão {draftRevision}.', 'Restaurar a revisão {revision} como novo rascunho?', 'Restaurando rascunho…', 'Voltar à versão atual', 'Ver revisão {revision}', 'Visualizando'],
  'es-ES': ['Viendo la revisión {revision} · Solo lectura', 'Cancelar', 'Vuelve a la versión actual para editar esta revisión histórica.', 'Commit actual', 'El historial confirmado no cambiará.', 'Esta versión histórica no está disponible.', 'Restaurar como borrador nuevo', 'El borrador actual cambió. Se recargó el contexto más reciente; confirma la restauración otra vez.', 'La revisión {revision} reemplazará el borrador actual revisión {draftRevision}.', 'No se pudo restaurar la revisión {revision}. Inténtalo de nuevo.', 'La revisión {revision} se restauró como borrador nuevo revisión {draftRevision}.', '¿Restaurar la revisión {revision} como borrador nuevo?', 'Restaurando borrador…', 'Volver a la versión actual', 'Ver revisión {revision}', 'Viendo'],
  ru: ['Просмотр редакции {revision} · Только чтение', 'Отмена', 'Вернитесь к текущей версии, чтобы изменить эту историческую редакцию.', 'Текущий коммит', 'История коммитов останется неизменной.', 'Эта историческая версия недоступна.', 'Восстановить как новый черновик', 'Текущий черновик изменился. Последний контекст перезагружен; подтвердите восстановление снова.', 'Редакция {revision} заменит текущий черновик редакции {draftRevision}.', 'Не удалось восстановить редакцию {revision}. Повторите попытку.', 'Редакция {revision} восстановлена как новый черновик редакции {draftRevision}.', 'Восстановить редакцию {revision} как новый черновик?', 'Восстановление черновика…', 'Вернуться к текущей версии', 'Просмотреть редакцию {revision}', 'Просматривается'],
  fa: ['در حال مشاهده بازبینی {revision} · فقط خواندنی', 'لغو', 'برای ویرایش این بازبینی تاریخی به نسخهٔ فعلی برگردید.', 'ثبت فعلی', 'تاریخچهٔ ثبت‌شده بدون تغییر می‌ماند.', 'این نسخهٔ تاریخی در دسترس نیست.', 'بازیابی به‌عنوان پیش‌نویس جدید', 'پیش‌نویس فعلی تغییر کرده است. آخرین زمینه دوباره بارگیری شد؛ بازیابی را دوباره تأیید کنید.', 'بازبینی {revision} جایگزین پیش‌نویس فعلی بازبینی {draftRevision} می‌شود.', 'بازبینی {revision} بازیابی نشد. دوباره تلاش کنید.', 'بازبینی {revision} به‌عنوان پیش‌نویس جدید بازبینی {draftRevision} بازیابی شد.', 'بازبینی {revision} به‌عنوان پیش‌نویس جدید بازیابی شود؟', 'در حال بازیابی پیش‌نویس…', 'بازگشت به نسخهٔ فعلی', 'مشاهدهٔ بازبینی {revision}', 'در حال مشاهده'],
  ar: ['عرض المراجعة {revision} · للقراءة فقط', 'إلغاء', 'ارجع إلى الإصدار الحالي لتحرير هذه المراجعة التاريخية.', 'الالتزام الحالي', 'سيبقى سجل الالتزامات دون تغيير.', 'هذا الإصدار التاريخي غير متاح.', 'استعادة كمسودة جديدة', 'تغيرت المسودة الحالية. أُعيد تحميل أحدث سياق؛ أكّد الاستعادة مرة أخرى.', 'ستستبدل المراجعة {revision} المسودة الحالية ذات المراجعة {draftRevision}.', 'تعذرت استعادة المراجعة {revision}. حاول مرة أخرى.', 'استُعيدت المراجعة {revision} كمسودة جديدة ذات مراجعة {draftRevision}.', 'استعادة المراجعة {revision} كمسودة جديدة؟', 'جارٍ استعادة المسودة…', 'العودة إلى الإصدار الحالي', 'عرض المراجعة {revision}', 'قيد العرض'],
  ja: ['リビジョン {revision} を表示中 · 読み取り専用', 'キャンセル', 'この履歴リビジョンを編集するには現在のバージョンに戻ってください。', '現在のコミット', 'コミット履歴は変更されません。', 'この履歴バージョンは利用できません。', '新しい下書きとして復元', '現在の下書きが変更されました。最新のコンテキストを再読み込みしたため、復元をもう一度確認してください。', 'リビジョン {revision} は現在の下書きリビジョン {draftRevision} を置き換えます。', 'リビジョン {revision} を復元できませんでした。もう一度お試しください。', 'リビジョン {revision} を新しい下書きリビジョン {draftRevision} として復元しました。', 'リビジョン {revision} を新しい下書きとして復元しますか？', '下書きを復元中…', '現在のバージョンに戻る', 'リビジョン {revision} を表示', '表示中'],
  ko: ['리비전 {revision} 보는 중 · 읽기 전용', '취소', '이 기록 리비전을 편집하려면 현재 버전으로 돌아가세요.', '현재 커밋', '커밋 기록은 변경되지 않습니다.', '이 기록 버전은 사용할 수 없습니다.', '새 초안으로 복원', '현재 초안이 변경되었습니다. 최신 컨텍스트를 다시 불러왔으니 복원을 다시 확인하세요.', '리비전 {revision}이(가) 현재 초안 리비전 {draftRevision}을(를) 대체합니다.', '리비전 {revision}을(를) 복원할 수 없습니다. 다시 시도하세요.', '리비전 {revision}을(를) 새 초안 리비전 {draftRevision}(으)로 복원했습니다.', '리비전 {revision}을(를) 새 초안으로 복원할까요?', '초안 복원 중…', '현재 버전으로 돌아가기', '리비전 {revision} 보기', '보고 있음'],
  pl: ['Wyświetlanie wersji {revision} · Tylko do odczytu', 'Anuluj', 'Wróć do bieżącej wersji, aby edytować tę historyczną wersję.', 'Bieżący commit', 'Historia commitów pozostanie bez zmian.', 'Ta historyczna wersja jest niedostępna.', 'Przywróć jako nowy szkic', 'Bieżący szkic się zmienił. Wczytano najnowszy kontekst; ponownie potwierdź przywrócenie.', 'Wersja {revision} zastąpi bieżący szkic wersji {draftRevision}.', 'Nie udało się przywrócić wersji {revision}. Spróbuj ponownie.', 'Wersja {revision} została przywrócona jako nowy szkic wersji {draftRevision}.', 'Przywrócić wersję {revision} jako nowy szkic?', 'Przywracanie szkicu…', 'Wróć do bieżącej wersji', 'Wyświetl wersję {revision}', 'Wyświetlana'],
  hu: ['{revision}. verzió megtekintése · Csak olvasható', 'Mégse', 'A történeti verzió szerkesztéséhez térjen vissza az aktuális verzióhoz.', 'Jelenlegi commit', 'A commitelőzmények változatlanok maradnak.', 'Ez a történeti verzió nem érhető el.', 'Visszaállítás új vázlatként', 'Az aktuális vázlat megváltozott. A legújabb környezet újratöltődött; erősítse meg újra a visszaállítást.', 'A(z) {revision}. verzió felülírja a(z) {draftRevision}. aktuális vázlatot.', 'A(z) {revision}. verziót nem lehetett visszaállítani. Próbálja újra.', 'A(z) {revision}. verzió új {draftRevision}. vázlatként lett visszaállítva.', 'Visszaállítja a(z) {revision}. verziót új vázlatként?', 'Vázlat visszaállítása…', 'Vissza az aktuális verzióhoz', '{revision}. verzió megtekintése', 'Megtekintés alatt'],
  fr: ['Affichage de la révision {revision} · Lecture seule', 'Annuler', 'Revenez à la version actuelle pour modifier cette révision historique.', 'Commit actuel', 'L’historique des commits restera inchangé.', 'Cette version historique est indisponible.', 'Restaurer comme nouveau brouillon', 'Le brouillon actuel a changé. Le dernier contexte a été rechargé ; confirmez à nouveau la restauration.', 'La révision {revision} remplacera le brouillon actuel révision {draftRevision}.', 'Impossible de restaurer la révision {revision}. Réessayez.', 'La révision {revision} a été restaurée comme nouveau brouillon révision {draftRevision}.', 'Restaurer la révision {revision} comme nouveau brouillon ?', 'Restauration du brouillon…', 'Revenir à la version actuelle', 'Afficher la révision {revision}', 'Affichage'],
  uk: ['Перегляд редакції {revision} · Лише читання', 'Скасувати', 'Поверніться до поточної версії, щоб редагувати цю історичну редакцію.', 'Поточний коміт', 'Історія комітів залишиться незмінною.', 'Ця історична версія недоступна.', 'Відновити як нову чернетку', 'Поточна чернетка змінилася. Останній контекст перезавантажено; підтвердьте відновлення ще раз.', 'Редакція {revision} замінить поточну чернетку редакції {draftRevision}.', 'Не вдалося відновити редакцію {revision}. Спробуйте ще раз.', 'Редакцію {revision} відновлено як нову чернетку редакції {draftRevision}.', 'Відновити редакцію {revision} як нову чернетку?', 'Відновлення чернетки…', 'Повернутися до поточної версії', 'Переглянути редакцію {revision}', 'Переглядається'],
  tr: ['{revision}. revizyon görüntüleniyor · Salt okunur', 'İptal', 'Bu geçmiş revizyonu düzenlemek için geçerli sürüme dönün.', 'Geçerli commit', 'Commit geçmişi değişmeden kalacak.', 'Bu geçmiş sürüm kullanılamıyor.', 'Yeni taslak olarak geri yükle', 'Geçerli taslak değişti. En son bağlam yeniden yüklendi; geri yüklemeyi tekrar onaylayın.', '{revision}. revizyon, {draftRevision}. geçerli taslağın yerini alacak.', '{revision}. revizyon geri yüklenemedi. Yeniden deneyin.', '{revision}. revizyon, {draftRevision}. yeni taslak olarak geri yüklendi.', '{revision}. revizyon yeni taslak olarak geri yüklensin mi?', 'Taslak geri yükleniyor…', 'Geçerli sürüme dön', '{revision}. revizyonu görüntüle', 'Görüntüleniyor'],
  th: ['กำลังดูรีวิชัน {revision} · อ่านอย่างเดียว', 'ยกเลิก', 'กลับไปยังเวอร์ชันปัจจุบันเพื่อแก้ไขรีวิชันประวัตินี้', 'คอมมิตปัจจุบัน', 'ประวัติคอมมิตจะไม่เปลี่ยนแปลง', 'เวอร์ชันประวัตินี้ไม่พร้อมใช้งาน', 'กู้คืนเป็นฉบับร่างใหม่', 'ฉบับร่างปัจจุบันเปลี่ยนไปแล้ว โหลดบริบทล่าสุดแล้ว; โปรดยืนยันการกู้คืนอีกครั้ง', 'รีวิชัน {revision} จะแทนที่ฉบับร่างปัจจุบันรีวิชัน {draftRevision}', 'ไม่สามารถกู้คืนรีวิชัน {revision} ได้ โปรดลองอีกครั้ง', 'กู้คืนรีวิชัน {revision} เป็นฉบับร่างใหม่รีวิชัน {draftRevision} แล้ว', 'กู้คืนรีวิชัน {revision} เป็นฉบับร่างใหม่หรือไม่?', 'กำลังกู้คืนฉบับร่าง…', 'กลับไปยังเวอร์ชันปัจจุบัน', 'ดูรีวิชัน {revision}', 'กำลังดู'],
  it: ['Visualizzazione della revisione {revision} · Sola lettura', 'Annulla', 'Torna alla versione corrente per modificare questa revisione storica.', 'Commit corrente', 'La cronologia dei commit rimarrà invariata.', 'Questa versione storica non è disponibile.', 'Ripristina come nuova bozza', 'La bozza corrente è cambiata. È stato ricaricato il contesto più recente; conferma di nuovo il ripristino.', 'La revisione {revision} sostituirà la bozza corrente revisione {draftRevision}.', 'Impossibile ripristinare la revisione {revision}. Riprova.', 'La revisione {revision} è stata ripristinata come nuova bozza revisione {draftRevision}.', 'Ripristinare la revisione {revision} come nuova bozza?', 'Ripristino bozza…', 'Torna alla versione corrente', 'Visualizza revisione {revision}', 'Visualizzazione'],
} satisfies Record<Locale, RevisionCopy>;

const copy = {
  en: {
    agent: ['Map editing unavailable', 'Public reasoning summaries available'],
    composer: ['Attachments unavailable', 'Enter to send', 'Message map agent', 'Messages are limited to {limit} characters.', 'Describe the map change', 'Send', 'Run actions'],
    activity: ['Working', 'Completed', 'Failed', 'Canceled', '{count} step', '{count} steps', 'Expand details', 'Collapse details', 'Working step', 'Reasoning summary', 'Earlier tool steps omitted', 'Preparing', 'Analyzing', 'Validating', 'Rendering preview', 'Committing', 'Thinking', 'Request summary', 'Result summary', 'Read map context', 'Inspect map', 'Search layers', 'Apply map changes', 'Update map semantics', 'Validate map', 'Render preview', 'Commit revision', 'Discard draft', 'Tool activity', '{count} earlier tool steps omitted', '{count} failed'],
    conversation: ['Cancel run', 'Map design agent chat', 'Collapse chat', 'The conversation could not be created.', 'Creating conversation', 'Creating conversation…', 'New conversation', 'Expand design conversation', 'The conversations could not be loaded.', 'Project conversations', 'The conversation could not be loaded.', 'Loading conversations…', '{count} messages', '{count} message', 'No conversation is available for this project.', 'Map project', 'Design conversation collapsed', 'Resize design conversation', 'Retry', 'Run active', 'Running', 'The requested conversation is unavailable. Showing the newest conversation.'],
    workspace: ['Configure an available local agent to use this map workspace.', 'Map import failed.', 'Importing map source…', 'Unable to load this map workspace.', 'Loading map workspace…', 'Open Settings', 'Retry import', 'That map is no longer available.'],
    navigation: ['Map navigation', 'Zoom in', 'Zoom out', 'Locate me', 'Reset compass to north', 'Location is unavailable in this browser.', 'Finding your location…', 'Map centered on your location.', 'Your location could not be accessed.'],
  },
  id: {
    agent: ['Pengeditan peta tidak tersedia', 'Ringkasan penalaran publik tersedia'],
    composer: ['Lampiran tidak tersedia', 'Tekan Enter untuk mengirim', 'Kirim pesan ke agen peta', 'Pesan dibatasi hingga {limit} karakter.', 'Jelaskan perubahan peta', 'Kirim', 'Tindakan proses'],
    activity: ['Sedang berjalan', 'Selesai', 'Gagal', 'Dibatalkan', '{count} langkah', '{count} langkah', 'Perluas detail', 'Ciutkan detail', 'Langkah berjalan', 'Ringkasan penalaran', 'Langkah alat sebelumnya dihilangkan', 'Menyiapkan', 'Menganalisis', 'Memvalidasi', 'Merender pratinjau', 'Menyimpan revisi', 'Berpikir', 'Ringkasan permintaan', 'Ringkasan hasil', 'Baca konteks peta', 'Periksa peta', 'Cari layer', 'Terapkan perubahan peta', 'Perbarui semantik peta', 'Validasi peta', 'Render pratinjau', 'Simpan revisi', 'Buang draf', 'Aktivitas alat', '{count} langkah alat sebelumnya dihilangkan', '{count} gagal'],
    conversation: ['Batalkan proses', 'Obrolan agen desain peta', 'Ciutkan obrolan', 'Percakapan tidak dapat dibuat.', 'Membuat percakapan', 'Membuat percakapan…', 'Percakapan baru', 'Perluas percakapan desain', 'Percakapan tidak dapat dimuat.', 'Percakapan proyek', 'Percakapan tidak dapat dimuat.', 'Memuat percakapan…', 'Pesan: {count}', 'Pesan: {count}', 'Tidak ada percakapan untuk proyek ini.', 'Proyek peta', 'Percakapan desain diciutkan', 'Ubah ukuran percakapan desain', 'Coba lagi', 'Proses aktif', 'Berjalan', 'Percakapan yang diminta tidak tersedia. Menampilkan percakapan terbaru.'],
    workspace: ['Konfigurasikan agen lokal yang tersedia untuk menggunakan ruang kerja peta ini.', 'Impor peta gagal.', 'Mengimpor sumber peta…', 'Ruang kerja peta ini tidak dapat dimuat.', 'Memuat ruang kerja peta…', 'Buka Pengaturan', 'Coba impor lagi', 'Peta itu tidak lagi tersedia.'],
    navigation: ['Navigasi peta', 'Perbesar', 'Perkecil', 'Temukan lokasi saya', 'Atur kompas ke utara', 'Lokasi tidak tersedia di browser ini.', 'Mencari lokasi Anda…', 'Peta dipusatkan ke lokasi Anda.', 'Lokasi Anda tidak dapat diakses.'],
  },
  de: {
    agent: ['Kartenbearbeitung nicht verfügbar', 'Öffentliche Denkzusammenfassungen verfügbar'],
    composer: ['Anhänge sind nicht verfügbar', 'Zum Senden Enter drücken', 'Nachricht an den Kartenagenten', 'Nachrichten sind auf {limit} Zeichen begrenzt.', 'Kartenänderung beschreiben', 'Senden', 'Ausführungsaktionen'],
    activity: ['In Bearbeitung', 'Abgeschlossen', 'Fehlgeschlagen', 'Abgebrochen', '{count} Schritt', '{count} Schritte', 'Details erweitern', 'Details einklappen', 'Laufender Schritt', 'Zusammenfassung der Überlegungen', 'Frühere Werkzeugschritte ausgelassen', 'Wird vorbereitet', 'Wird analysiert', 'Wird validiert', 'Vorschau wird gerendert', 'Revision wird gespeichert', 'Überlegung', 'Anforderungsübersicht', 'Ergebnisübersicht', 'Kartenkontext lesen', 'Karte prüfen', 'Ebenen durchsuchen', 'Kartenänderungen anwenden', 'Kartensemantik aktualisieren', 'Karte validieren', 'Vorschau rendern', 'Revision speichern', 'Entwurf verwerfen', 'Werkzeugaktivität', '{count} frühere Werkzeugschritte ausgelassen', '{count} fehlgeschlagen'],
    conversation: ['Ausführung abbrechen', 'Chat mit dem Kartendesign-Agenten', 'Chat einklappen', 'Die Unterhaltung konnte nicht erstellt werden.', 'Unterhaltung wird erstellt', 'Unterhaltung wird erstellt…', 'Neue Unterhaltung', 'Design-Unterhaltung ausklappen', 'Die Unterhaltungen konnten nicht geladen werden.', 'Projektunterhaltungen', 'Die Unterhaltung konnte nicht geladen werden.', 'Unterhaltungen werden geladen…', 'Nachrichten: {count}', 'Nachrichten: {count}', 'Für dieses Projekt ist keine Unterhaltung verfügbar.', 'Kartenprojekt', 'Design-Unterhaltung eingeklappt', 'Design-Unterhaltung vergrößern oder verkleinern', 'Erneut versuchen', 'Ausführung aktiv', 'Wird ausgeführt', 'Die angeforderte Unterhaltung ist nicht verfügbar. Die neueste Unterhaltung wird angezeigt.'],
    workspace: ['Konfigurieren Sie einen verfügbaren lokalen Agenten, um diesen Kartenarbeitsbereich zu verwenden.', 'Der Kartenimport ist fehlgeschlagen.', 'Kartenquelle wird importiert…', 'Dieser Kartenarbeitsbereich konnte nicht geladen werden.', 'Kartenarbeitsbereich wird geladen…', 'Einstellungen öffnen', 'Import erneut versuchen', 'Diese Karte ist nicht mehr verfügbar.'],
    navigation: ['Kartennavigation', 'Vergrößern', 'Verkleinern', 'Mich orten', 'Kompass nach Norden ausrichten', 'Der Standort ist in diesem Browser nicht verfügbar.', 'Standort wird ermittelt…', 'Karte auf Ihren Standort zentriert.', 'Auf Ihren Standort konnte nicht zugegriffen werden.'],
  },
  'zh-CN': {
    agent: ['地图编辑不可用', '可使用公开推理摘要'],
    composer: ['暂不支持附件', '按 Enter 发送', '向地图智能体发送消息', '消息不能超过 {limit} 个字符。', '描述地图更改', '发送', '运行操作'],
    activity: ['进行中', '已完成', '失败', '已取消', '{count} 个步骤', '{count} 个步骤', '展开详情', '收起详情', '正在处理的步骤', '推理摘要', '已省略先前的工具步骤', '准备中', '分析中', '验证中', '正在渲染预览', '正在提交', '思考中', '请求摘要', '结果摘要', '读取地图上下文', '检查地图', '搜索图层', '应用地图更改', '更新地图语义', '验证地图', '渲染预览', '提交修订', '放弃草稿', '工具活动', '已省略先前的 {count} 个工具步骤', '{count} 个失败'],
    conversation: ['取消运行', '地图设计智能体对话', '折叠对话', '无法创建对话。', '正在创建对话', '正在创建对话…', '新对话', '展开设计对话', '无法加载对话列表。', '项目对话', '无法加载对话。', '正在加载对话…', '{count} 条消息', '{count} 条消息', '此项目没有可用的对话。', '地图项目', '设计对话已折叠', '调整设计对话大小', '重试', '运行中', '正在运行', '请求的对话不可用。正在显示最新对话。'],
    workspace: ['请配置可用的本地智能体以使用此地图工作区。', '地图导入失败。', '正在导入地图源…', '无法加载此地图工作区。', '正在加载地图工作区…', '打开设置', '重试导入', '该地图已不可用。'],
    navigation: ['地图导航', '放大', '缩小', '定位到我', '将指南针重置为北向', '此浏览器无法使用定位功能。', '正在获取您的位置…', '地图已居中到您的位置。', '无法访问您的位置。'],
  },
  'zh-TW': {
    agent: ['地圖編輯無法使用', '可使用公開推理摘要'],
    composer: ['暫不支援附件', '按 Enter 傳送', '傳訊息給地圖代理程式', '訊息不能超過 {limit} 個字元。', '描述地圖變更', '傳送', '執行操作'],
    activity: ['處理中', '已完成', '失敗', '已取消', '{count} 個步驟', '{count} 個步驟', '展開詳細資料', '收合詳細資料', '正在處理的步驟', '推理摘要', '已省略先前的工具步驟', '準備中', '分析中', '驗證中', '正在渲染預覽', '正在提交', '思考中', '請求摘要', '結果摘要', '讀取地圖內容', '檢查地圖', '搜尋圖層', '套用地圖變更', '更新地圖語意', '驗證地圖', '渲染預覽', '提交修訂', '放棄草稿', '工具活動', '已省略先前的 {count} 個工具步驟', '{count} 個失敗'],
    conversation: ['取消執行', '地圖設計代理程式對話', '收合對話', '無法建立對話。', '正在建立對話', '正在建立對話…', '新對話', '展開設計對話', '無法載入對話清單。', '專案對話', '無法載入對話。', '正在載入對話…', '{count} 則訊息', '{count} 則訊息', '此專案沒有可用的對話。', '地圖專案', '設計對話已收合', '調整設計對話大小', '重試', '執行中', '正在執行', '要求的對話無法使用。正在顯示最新對話。'],
    workspace: ['請設定可用的本機代理程式以使用此地圖工作區。', '地圖匯入失敗。', '正在匯入地圖來源…', '無法載入此地圖工作區。', '正在載入地圖工作區…', '開啟設定', '重試匯入', '該地圖已無法使用。'],
    navigation: ['地圖導覽', '放大', '縮小', '定位到我', '將指南針重設為北向', '此瀏覽器無法使用定位功能。', '正在取得您的位置…', '地圖已置中到您的位置。', '無法存取您的位置。'],
  },
  'pt-BR': {
    agent: ['Edição de mapa indisponível', 'Resumos públicos de raciocínio disponíveis'],
    composer: ['Anexos indisponíveis', 'Pressione Enter para enviar', 'Enviar mensagem ao agente de mapas', 'As mensagens têm o limite de {limit} caracteres.', 'Descreva a alteração no mapa', 'Enviar', 'Ações de execução'],
    activity: ['Em andamento', 'Concluído', 'Falhou', 'Cancelado', '{count} etapa', '{count} etapas', 'Expandir detalhes', 'Recolher detalhes', 'Etapa em andamento', 'Resumo do raciocínio', 'Etapas anteriores da ferramenta omitidas', 'Preparando', 'Analisando', 'Validando', 'Renderizando prévia', 'Confirmando revisão', 'Raciocinando', 'Resumo da solicitação', 'Resumo do resultado', 'Ler contexto do mapa', 'Inspecionar mapa', 'Pesquisar camadas', 'Aplicar alterações no mapa', 'Atualizar semântica do mapa', 'Validar mapa', 'Renderizar prévia', 'Confirmar revisão', 'Descartar rascunho', 'Atividade da ferramenta', '{count} etapas anteriores da ferramenta omitidas', '{count} com falha'],
    conversation: ['Cancelar execução', 'Conversa com o agente de design de mapas', 'Recolher conversa', 'Não foi possível criar a conversa.', 'Criando conversa', 'Criando conversa…', 'Nova conversa', 'Expandir conversa de design', 'Não foi possível carregar as conversas.', 'Conversas do projeto', 'Não foi possível carregar a conversa.', 'Carregando conversas…', 'Mensagens: {count}', 'Mensagens: {count}', 'Não há conversa disponível para este projeto.', 'Projeto de mapa', 'Conversa de design recolhida', 'Redimensionar conversa de design', 'Tentar novamente', 'Execução ativa', 'Em execução', 'A conversa solicitada não está disponível. Exibindo a conversa mais recente.'],
    workspace: ['Configure um agente local disponível para usar este espaço de trabalho de mapas.', 'Falha ao importar o mapa.', 'Importando fonte do mapa…', 'Não foi possível carregar este espaço de trabalho de mapas.', 'Carregando espaço de trabalho de mapas…', 'Abrir configurações', 'Tentar importar novamente', 'Esse mapa não está mais disponível.'],
    navigation: ['Navegação do mapa', 'Aumentar zoom', 'Diminuir zoom', 'Localizar-me', 'Redefinir bússola para o norte', 'A localização não está disponível neste navegador.', 'Localizando você…', 'Mapa centralizado na sua localização.', 'Não foi possível acessar sua localização.'],
  },
  'es-ES': {
    agent: ['Edición de mapas no disponible', 'Resúmenes públicos de razonamiento disponibles'],
    composer: ['Los archivos adjuntos no están disponibles', 'Pulsa Enter para enviar', 'Enviar mensaje al agente de mapas', 'Los mensajes están limitados a {limit} caracteres.', 'Describe el cambio del mapa', 'Enviar', 'Acciones de ejecución'],
    activity: ['En curso', 'Completado', 'Error', 'Cancelado', '{count} paso', '{count} pasos', 'Expandir detalles', 'Contraer detalles', 'Paso en curso', 'Resumen del razonamiento', 'Se omitieron pasos anteriores de la herramienta', 'Preparando', 'Analizando', 'Validando', 'Generando vista previa', 'Confirmando revisión', 'Razonando', 'Resumen de la solicitud', 'Resumen del resultado', 'Leer contexto del mapa', 'Inspeccionar mapa', 'Buscar capas', 'Aplicar cambios al mapa', 'Actualizar semántica del mapa', 'Validar mapa', 'Generar vista previa', 'Confirmar revisión', 'Descartar borrador', 'Actividad de herramienta', 'Se omitieron {count} pasos anteriores de la herramienta', '{count} con error'],
    conversation: ['Cancelar ejecución', 'Chat del agente de diseño de mapas', 'Contraer chat', 'No se pudo crear la conversación.', 'Creando conversación', 'Creando conversación…', 'Nueva conversación', 'Expandir conversación de diseño', 'No se pudieron cargar las conversaciones.', 'Conversaciones del proyecto', 'No se pudo cargar la conversación.', 'Cargando conversaciones…', 'Mensajes: {count}', 'Mensajes: {count}', 'No hay ninguna conversación disponible para este proyecto.', 'Proyecto de mapa', 'Conversación de diseño contraída', 'Cambiar el tamaño de la conversación de diseño', 'Reintentar', 'Ejecución activa', 'En ejecución', 'La conversación solicitada no está disponible. Se muestra la conversación más reciente.'],
    workspace: ['Configura un agente local disponible para usar este espacio de trabajo de mapas.', 'La importación del mapa ha fallado.', 'Importando la fuente del mapa…', 'No se pudo cargar este espacio de trabajo de mapas.', 'Cargando el espacio de trabajo de mapas…', 'Abrir Ajustes', 'Reintentar importación', 'Ese mapa ya no está disponible.'],
    navigation: ['Navegación del mapa', 'Acercar', 'Alejar', 'Localizarme', 'Restablecer brújula al norte', 'La ubicación no está disponible en este navegador.', 'Buscando tu ubicación…', 'Mapa centrado en tu ubicación.', 'No se pudo acceder a tu ubicación.'],
  },
  ru: {
    agent: ['Редактирование карты недоступно', 'Доступны публичные сводки рассуждений'],
    composer: ['Вложения недоступны', 'Нажмите Enter для отправки', 'Сообщение картографическому агенту', 'Длина сообщения ограничена {limit} символами.', 'Опишите изменение карты', 'Отправить', 'Действия запуска'],
    activity: ['Выполняется', 'Завершено', 'Не удалось', 'Отменено', '{count} шаг', '{count} шагов', 'Развернуть подробности', 'Свернуть подробности', 'Выполняемый шаг', 'Сводка рассуждений', 'Предыдущие шаги инструментов пропущены', 'Подготовка', 'Анализ', 'Проверка', 'Создание предпросмотра', 'Фиксация ревизии', 'Обдумывание', 'Сводка запроса', 'Сводка результата', 'Прочитать контекст карты', 'Исследовать карту', 'Найти слои', 'Применить изменения карты', 'Обновить семантику карты', 'Проверить карту', 'Создать предпросмотр', 'Зафиксировать ревизию', 'Отбросить черновик', 'Действие инструмента', 'Пропущено предыдущих шагов инструментов: {count}', 'С ошибкой: {count}'],
    conversation: ['Отменить выполнение', 'Чат с агентом дизайна карт', 'Свернуть чат', 'Не удалось создать беседу.', 'Создание беседы', 'Создание беседы…', 'Новая беседа', 'Развернуть беседу о дизайне', 'Не удалось загрузить беседы.', 'Беседы проекта', 'Не удалось загрузить беседу.', 'Загрузка бесед…', 'Сообщений: {count}', 'Сообщений: {count}', 'Для этого проекта нет доступных бесед.', 'Картографический проект', 'Беседа о дизайне свернута', 'Изменить размер беседы о дизайне', 'Повторить', 'Выполнение активно', 'Выполняется', 'Запрошенная беседа недоступна. Показана самая новая беседа.'],
    workspace: ['Настройте доступного локального агента для работы с этой картой.', 'Не удалось импортировать карту.', 'Импорт источника карты…', 'Не удалось загрузить рабочую область карты.', 'Загрузка рабочей области карты…', 'Открыть настройки', 'Повторить импорт', 'Эта карта больше недоступна.'],
    navigation: ['Навигация по карте', 'Приблизить', 'Отдалить', 'Найти меня', 'Повернуть компас на север', 'Геолокация недоступна в этом браузере.', 'Определяем ваше местоположение…', 'Карта центрирована на вашем местоположении.', 'Не удалось получить доступ к вашему местоположению.'],
  },
  fa: {
    agent: ['ویرایش نقشه در دسترس نیست', 'خلاصه‌های استدلال عمومی در دسترس هستند'],
    composer: ['پیوست‌ها در دسترس نیستند', 'برای ارسال Enter را بزنید', 'پیام به نماینده نقشه', 'پیام‌ها به {limit} نویسه محدود هستند.', 'تغییر نقشه را توضیح دهید', 'ارسال', 'اقدامات اجرا'],
    activity: ['در حال اجرا', 'تکمیل شد', 'ناموفق', 'لغو شد', '{count} گام', '{count} گام', 'نمایش جزئیات', 'پنهان کردن جزئیات', 'گام در حال اجرا', 'خلاصه استدلال', 'گام‌های قبلی ابزار حذف شدند', 'آماده‌سازی', 'تحلیل', 'اعتبارسنجی', 'در حال رندر پیش‌نمایش', 'ثبت بازبینی', 'در حال استدلال', 'خلاصه درخواست', 'خلاصه نتیجه', 'خواندن زمینه نقشه', 'بررسی نقشه', 'جستجوی لایه‌ها', 'اعمال تغییرات نقشه', 'به‌روزرسانی معنای نقشه', 'اعتبارسنجی نقشه', 'رندر پیش‌نمایش', 'ثبت بازبینی', 'کنار گذاشتن پیش‌نویس', 'فعالیت ابزار', '{count} گام قبلی ابزار حذف شد', '{count} ناموفق'],
    conversation: ['لغو اجرا', 'گفت‌وگو با نماینده طراحی نقشه', 'جمع کردن گفت‌وگو', 'گفت‌وگو ایجاد نشد.', 'در حال ایجاد گفت‌وگو', 'در حال ایجاد گفت‌وگو…', 'گفت‌وگوی جدید', 'باز کردن گفت‌وگوی طراحی', 'گفت‌وگوها بارگیری نشدند.', 'گفت‌وگوهای پروژه', 'گفت‌وگو بارگیری نشد.', 'در حال بارگیری گفت‌وگوها…', 'پیام‌ها: {count}', 'پیام‌ها: {count}', 'هیچ گفت‌وگویی برای این پروژه در دسترس نیست.', 'پروژه نقشه', 'گفت‌وگوی طراحی جمع شده است', 'تغییر اندازه گفت‌وگوی طراحی', 'تلاش دوباره', 'اجرا فعال است', 'در حال اجرا', 'گفت‌وگوی درخواستی در دسترس نیست. جدیدترین گفت‌وگو نمایش داده می‌شود.'],
    workspace: ['برای استفاده از این فضای کاری نقشه، یک نماینده محلی در دسترس را پیکربندی کنید.', 'وارد کردن نقشه ناموفق بود.', 'در حال وارد کردن منبع نقشه…', 'این فضای کاری نقشه بارگیری نشد.', 'در حال بارگیری فضای کاری نقشه…', 'باز کردن تنظیمات', 'تلاش دوباره برای وارد کردن', 'آن نقشه دیگر در دسترس نیست.'],
    navigation: ['پیمایش نقشه', 'بزرگ‌نمایی', 'کوچک‌نمایی', 'مکان من', 'تنظیم قطب‌نما به سمت شمال', 'مکان‌یابی در این مرورگر در دسترس نیست.', 'در حال یافتن مکان شما…', 'نقشه روی مکان شما متمرکز شد.', 'دسترسی به مکان شما ممکن نبود.'],
  },
  ar: {
    agent: ['تحرير الخريطة غير متاح', 'ملخصات الاستدلال العامة متاحة'],
    composer: ['المرفقات غير متاحة', 'اضغط Enter للإرسال', 'مراسلة وكيل الخرائط', 'الرسائل محدودة بـ {limit} حرفًا.', 'صِف تغيير الخريطة', 'إرسال', 'إجراءات التشغيل'],
    activity: ['قيد التنفيذ', 'مكتمل', 'فشل', 'أُلغي', '{count} خطوة', '{count} خطوات', 'توسيع التفاصيل', 'طي التفاصيل', 'خطوة قيد التنفيذ', 'ملخص الاستدلال', 'تم تجاوز خطوات الأداة السابقة', 'جارٍ التحضير', 'جارٍ التحليل', 'جارٍ التحقق', 'جارٍ عرض المعاينة', 'جارٍ تثبيت المراجعة', 'جارٍ التفكير', 'ملخص الطلب', 'ملخص النتيجة', 'قراءة سياق الخريطة', 'فحص الخريطة', 'البحث في الطبقات', 'تطبيق تغييرات الخريطة', 'تحديث دلالات الخريطة', 'التحقق من الخريطة', 'عرض المعاينة', 'تثبيت المراجعة', 'تجاهل المسودة', 'نشاط الأداة', 'تم تجاوز {count} من خطوات الأداة السابقة', '{count} فاشلة'],
    conversation: ['إلغاء التشغيل', 'محادثة وكيل تصميم الخرائط', 'طيّ المحادثة', 'تعذّر إنشاء المحادثة.', 'جارٍ إنشاء المحادثة', 'جارٍ إنشاء المحادثة…', 'محادثة جديدة', 'توسيع محادثة التصميم', 'تعذّر تحميل المحادثات.', 'محادثات المشروع', 'تعذّر تحميل المحادثة.', 'جارٍ تحميل المحادثات…', 'الرسائل: {count}', 'الرسائل: {count}', 'لا تتوفر محادثة لهذا المشروع.', 'مشروع الخريطة', 'محادثة التصميم مطوية', 'تغيير حجم محادثة التصميم', 'إعادة المحاولة', 'التشغيل نشط', 'قيد التشغيل', 'المحادثة المطلوبة غير متاحة. يتم عرض أحدث محادثة.'],
    workspace: ['اضبط وكيلاً محليًا متاحًا لاستخدام مساحة عمل الخريطة هذه.', 'فشل استيراد الخريطة.', 'جارٍ استيراد مصدر الخريطة…', 'تعذّر تحميل مساحة عمل الخريطة هذه.', 'جارٍ تحميل مساحة عمل الخريطة…', 'فتح الإعدادات', 'إعادة محاولة الاستيراد', 'لم تعد تلك الخريطة متاحة.'],
    navigation: ['التنقل في الخريطة', 'تكبير', 'تصغير', 'تحديد موقعي', 'إعادة البوصلة إلى الشمال', 'الموقع غير متاح في هذا المتصفح.', 'جارٍ تحديد موقعك…', 'تم توسيط الخريطة على موقعك.', 'تعذّر الوصول إلى موقعك.'],
  },
  ja: {
    agent: ['地図編集は利用できません', '公開推論サマリーを利用できます'],
    composer: ['添付ファイルは利用できません', 'Enter で送信', 'マップエージェントにメッセージを送る', 'メッセージは {limit} 文字以内です。', 'マップの変更内容を説明', '送信', '実行アクション'],
    activity: ['実行中', '完了', '失敗', 'キャンセル済み', '{count} ステップ', '{count} ステップ', '詳細を展開', '詳細を折りたたむ', '実行中のステップ', '推論の要約', '以前のツール手順を省略', '準備中', '分析中', '検証中', 'プレビューをレンダリング中', 'リビジョンをコミット中', '思考中', 'リクエストの要約', '結果の要約', 'マップコンテキストを読み取る', 'マップを検査', 'レイヤーを検索', 'マップの変更を適用', 'マップのセマンティクスを更新', 'マップを検証', 'プレビューをレンダリング', 'リビジョンをコミット', '下書きを破棄', 'ツールのアクティビティ', '以前のツール手順を {count} 件省略', '失敗 {count} 件'],
    conversation: ['実行をキャンセル', 'マップデザインエージェントのチャット', 'チャットを折りたたむ', '会話を作成できませんでした。', '会話を作成中', '会話を作成中…', '新しい会話', 'デザイン会話を展開', '会話を読み込めませんでした。', 'プロジェクトの会話', '会話を読み込めませんでした。', '会話を読み込み中…', 'メッセージ {count} 件', 'メッセージ {count} 件', 'このプロジェクトで利用できる会話はありません。', 'マッププロジェクト', 'デザイン会話は折りたたまれています', 'デザイン会話のサイズを変更', '再試行', '実行中', '実行中', '指定された会話は利用できません。最新の会話を表示しています。'],
    workspace: ['このマップワークスペースを使用するには、利用可能なローカルエージェントを設定してください。', 'マップのインポートに失敗しました。', 'マップソースをインポート中…', 'このマップワークスペースを読み込めませんでした。', 'マップワークスペースを読み込み中…', '設定を開く', 'インポートを再試行', 'そのマップは利用できなくなりました。'],
    navigation: ['マップナビゲーション', '拡大', '縮小', '現在地を表示', 'コンパスを北に戻す', 'このブラウザーでは位置情報を利用できません。', '現在地を取得中…', '現在地を中心に表示しました。', '現在地にアクセスできませんでした。'],
  },
  ko: {
    agent: ['지도 편집을 사용할 수 없습니다', '공개 추론 요약을 사용할 수 있습니다'],
    composer: ['첨부 파일을 사용할 수 없음', 'Enter 키로 보내기', '지도 에이전트에게 메시지 보내기', '메시지는 {limit}자로 제한됩니다.', '지도 변경 사항 설명', '보내기', '실행 작업'],
    activity: ['작업 중', '완료됨', '실패함', '취소됨', '{count}단계', '{count}단계', '세부 정보 펼치기', '세부 정보 접기', '진행 중인 단계', '추론 요약', '이전 도구 단계 생략됨', '준비 중', '분석 중', '검증 중', '미리보기 렌더링 중', '리비전 커밋 중', '사고 중', '요청 요약', '결과 요약', '지도 컨텍스트 읽기', '지도 검사', '레이어 검색', '지도 변경사항 적용', '지도 의미 체계 업데이트', '지도 검증', '미리보기 렌더링', '리비전 커밋', '초안 삭제', '도구 활동', '이전 도구 단계 {count}개 생략됨', '실패 {count}개'],
    conversation: ['실행 취소', '지도 디자인 에이전트 채팅', '채팅 접기', '대화를 만들 수 없습니다.', '대화 만드는 중', '대화 만드는 중…', '새 대화', '디자인 대화 펼치기', '대화를 불러올 수 없습니다.', '프로젝트 대화', '대화를 불러올 수 없습니다.', '대화 불러오는 중…', '메시지 {count}개', '메시지 {count}개', '이 프로젝트에 사용 가능한 대화가 없습니다.', '지도 프로젝트', '디자인 대화가 접힘', '디자인 대화 크기 조절', '다시 시도', '실행 활성', '실행 중', '요청한 대화를 사용할 수 없습니다. 최신 대화를 표시합니다.'],
    workspace: ['이 지도 작업 공간을 사용하려면 사용 가능한 로컬 에이전트를 구성하세요.', '지도 가져오기에 실패했습니다.', '지도 소스 가져오는 중…', '이 지도 작업 공간을 불러올 수 없습니다.', '지도 작업 공간 불러오는 중…', '설정 열기', '가져오기 다시 시도', '해당 지도를 더 이상 사용할 수 없습니다.'],
    navigation: ['지도 탐색', '확대', '축소', '내 위치 찾기', '나침반을 북쪽으로 재설정', '이 브라우저에서는 위치를 사용할 수 없습니다.', '위치를 찾는 중…', '지도가 내 위치를 중심으로 이동했습니다.', '위치에 접근할 수 없습니다.'],
  },
  pl: {
    agent: ['Edycja mapy jest niedostępna', 'Publiczne podsumowania rozumowania są dostępne'],
    composer: ['Załączniki są niedostępne', 'Naciśnij Enter, aby wysłać', 'Wiadomość do agenta mapy', 'Wiadomości mogą mieć najwyżej {limit} znaków.', 'Opisz zmianę mapy', 'Wyślij', 'Działania uruchomienia'],
    activity: ['W toku', 'Ukończono', 'Niepowodzenie', 'Anulowano', '{count} krok', '{count} kroków', 'Rozwiń szczegóły', 'Zwiń szczegóły', 'Wykonywany krok', 'Podsumowanie rozumowania', 'Pominięto wcześniejsze kroki narzędzia', 'Przygotowywanie', 'Analizowanie', 'Sprawdzanie', 'Renderowanie podglądu', 'Zatwierdzanie wersji', 'Myślenie', 'Podsumowanie żądania', 'Podsumowanie wyniku', 'Odczytaj kontekst mapy', 'Sprawdź mapę', 'Wyszukaj warstwy', 'Zastosuj zmiany mapy', 'Zaktualizuj semantykę mapy', 'Zweryfikuj mapę', 'Renderuj podgląd', 'Zatwierdź wersję', 'Odrzuć szkic', 'Aktywność narzędzia', 'Pominięto {count} wcześniejszych kroków narzędzia', 'Niepowodzenia: {count}'],
    conversation: ['Anuluj uruchomienie', 'Czat z agentem projektowania map', 'Zwiń czat', 'Nie udało się utworzyć rozmowy.', 'Tworzenie rozmowy', 'Tworzenie rozmowy…', 'Nowa rozmowa', 'Rozwiń rozmowę o projekcie', 'Nie udało się wczytać rozmów.', 'Rozmowy projektu', 'Nie udało się wczytać rozmowy.', 'Wczytywanie rozmów…', 'Wiadomości: {count}', 'Wiadomości: {count}', 'Brak rozmowy dostępnej dla tego projektu.', 'Projekt mapy', 'Rozmowa o projekcie jest zwinięta', 'Zmień rozmiar rozmowy o projekcie', 'Ponów próbę', 'Uruchomienie aktywne', 'W toku', 'Żądana rozmowa jest niedostępna. Wyświetlono najnowszą rozmowę.'],
    workspace: ['Skonfiguruj dostępnego agenta lokalnego, aby korzystać z tego obszaru roboczego mapy.', 'Import mapy nie powiódł się.', 'Importowanie źródła mapy…', 'Nie udało się wczytać tego obszaru roboczego mapy.', 'Wczytywanie obszaru roboczego mapy…', 'Otwórz ustawienia', 'Ponów import', 'Ta mapa nie jest już dostępna.'],
    navigation: ['Nawigacja mapy', 'Powiększ', 'Pomniejsz', 'Znajdź mnie', 'Ustaw kompas na północ', 'Lokalizacja jest niedostępna w tej przeglądarce.', 'Ustalanie lokalizacji…', 'Mapa została wyśrodkowana na Twojej lokalizacji.', 'Nie udało się uzyskać dostępu do lokalizacji.'],
  },
  hu: {
    agent: ['A térképszerkesztés nem érhető el', 'Nyilvános érvelési összefoglalók elérhetők'],
    composer: ['A mellékletek nem érhetők el', 'Küldés az Enter billentyűvel', 'Üzenet a térképügynöknek', 'Az üzenetek legfeljebb {limit} karakteresek lehetnek.', 'Írja le a térkép módosítását', 'Küldés', 'Futtatási műveletek'],
    activity: ['Folyamatban', 'Befejezve', 'Sikertelen', 'Megszakítva', '{count} lépés', '{count} lépés', 'Részletek kibontása', 'Részletek összecsukása', 'Folyamatban lévő lépés', 'Érvelési összefoglaló', 'Korábbi eszközlépések kihagyva', 'Előkészítés', 'Elemzés', 'Ellenőrzés', 'Előnézet renderelése', 'Verzió rögzítése', 'Gondolkodás', 'Kérés összefoglalója', 'Eredmény összefoglalója', 'Térképkörnyezet beolvasása', 'Térkép vizsgálata', 'Rétegek keresése', 'Térképmódosítások alkalmazása', 'Térkép szemantikájának frissítése', 'Térkép ellenőrzése', 'Előnézet renderelése', 'Verzió rögzítése', 'Piszkozat elvetése', 'Eszköztevékenység', '{count} korábbi eszközlépés kihagyva', '{count} sikertelen'],
    conversation: ['Futtatás megszakítása', 'Térképtervező ügynök csevegése', 'Csevegés összecsukása', 'A beszélgetést nem sikerült létrehozni.', 'Beszélgetés létrehozása', 'Beszélgetés létrehozása…', 'Új beszélgetés', 'Tervezési beszélgetés kibontása', 'A beszélgetéseket nem sikerült betölteni.', 'Projektbeszélgetések', 'A beszélgetést nem sikerült betölteni.', 'Beszélgetések betöltése…', 'Üzenetek: {count}', 'Üzenetek: {count}', 'Ehhez a projekthez nem érhető el beszélgetés.', 'Térképprojekt', 'A tervezési beszélgetés össze van csukva', 'Tervezési beszélgetés átméretezése', 'Újrapróbálkozás', 'Aktív futtatás', 'Folyamatban', 'A kért beszélgetés nem érhető el. A legújabb beszélgetés látható.'],
    workspace: ['A térképes munkaterület használatához állítson be egy elérhető helyi ügynököt.', 'A térkép importálása sikertelen.', 'Térképforrás importálása…', 'A térképes munkaterületet nem sikerült betölteni.', 'Térképes munkaterület betöltése…', 'Beállítások megnyitása', 'Importálás újrapróbálása', 'Ez a térkép már nem érhető el.'],
    navigation: ['Térképnavigáció', 'Nagyítás', 'Kicsinyítés', 'Saját hely megkeresése', 'Iránytű visszaállítása északra', 'A helymeghatározás nem érhető el ebben a böngészőben.', 'Helyzet meghatározása…', 'A térkép a helyzetére lett középre állítva.', 'A helyzetéhez nem sikerült hozzáférni.'],
  },
  fr: {
    agent: ['La modification de la carte n’est pas disponible', 'Des résumés publics du raisonnement sont disponibles'],
    composer: ['Pièces jointes indisponibles', 'Appuyez sur Entrée pour envoyer', 'Envoyer un message à l’agent cartographique', 'Les messages sont limités à {limit} caractères.', 'Décrivez la modification de la carte', 'Envoyer', 'Actions d’exécution'],
    activity: ['En cours', 'Terminé', 'Échec', 'Annulé', '{count} étape', '{count} étapes', 'Développer les détails', 'Réduire les détails', 'Étape en cours', 'Résumé du raisonnement', 'Étapes d’outil précédentes omises', 'Préparation', 'Analyse', 'Validation', 'Génération de l’aperçu', 'Validation de la révision', 'Réflexion', 'Résumé de la requête', 'Résumé du résultat', 'Lire le contexte de la carte', 'Inspecter la carte', 'Rechercher des couches', 'Appliquer les modifications', 'Mettre à jour la sémantique de la carte', 'Valider la carte', 'Générer l’aperçu', 'Valider la révision', 'Abandonner le brouillon', 'Activité de l’outil', '{count} étapes d’outil précédentes omises', '{count} en échec'],
    conversation: ['Annuler l’exécution', 'Discussion avec l’agent de conception cartographique', 'Réduire la discussion', 'Impossible de créer la discussion.', 'Création de la discussion', 'Création de la discussion…', 'Nouvelle discussion', 'Développer la discussion de conception', 'Impossible de charger les discussions.', 'Discussions du projet', 'Impossible de charger la discussion.', 'Chargement des discussions…', 'Messages : {count}', 'Messages : {count}', 'Aucune discussion n’est disponible pour ce projet.', 'Projet cartographique', 'Discussion de conception réduite', 'Redimensionner la discussion de conception', 'Réessayer', 'Exécution active', 'En cours', 'La discussion demandée n’est pas disponible. La discussion la plus récente est affichée.'],
    workspace: ['Configurez un agent local disponible pour utiliser cet espace de travail cartographique.', 'L’importation de la carte a échoué.', 'Importation de la source cartographique…', 'Impossible de charger cet espace de travail cartographique.', 'Chargement de l’espace de travail cartographique…', 'Ouvrir les réglages', 'Réessayer l’importation', 'Cette carte n’est plus disponible.'],
    navigation: ['Navigation de la carte', 'Zoomer', 'Dézoomer', 'Me localiser', 'Réorienter la boussole vers le nord', 'La localisation n’est pas disponible dans ce navigateur.', 'Recherche de votre position…', 'Carte centrée sur votre position.', 'Impossible d’accéder à votre position.'],
  },
  uk: {
    agent: ['Редагування карти недоступне', 'Доступні публічні підсумки міркувань'],
    composer: ['Вкладення недоступні', 'Натисніть Enter, щоб надіслати', 'Повідомлення картографічному агенту', 'Повідомлення обмежені {limit} символами.', 'Опишіть зміну карти', 'Надіслати', 'Дії виконання'],
    activity: ['Виконується', 'Завершено', 'Не вдалося', 'Скасовано', '{count} крок', '{count} кроків', 'Розгорнути подробиці', 'Згорнути подробиці', 'Крок у виконанні', 'Підсумок міркувань', 'Попередні кроки інструментів пропущено', 'Підготовка', 'Аналіз', 'Перевірка', 'Створення попереднього перегляду', 'Фіксація ревізії', 'Обмірковування', 'Підсумок запиту', 'Підсумок результату', 'Прочитати контекст карти', 'Перевірити карту', 'Знайти шари', 'Застосувати зміни карти', 'Оновити семантику карти', 'Перевірити карту', 'Створити попередній перегляд', 'Зафіксувати ревізію', 'Відкинути чернетку', 'Дія інструмента', 'Пропущено попередніх кроків інструментів: {count}', 'Невдалі: {count}'],
    conversation: ['Скасувати виконання', 'Чат з агентом дизайну карт', 'Згорнути чат', 'Не вдалося створити розмову.', 'Створення розмови', 'Створення розмови…', 'Нова розмова', 'Розгорнути розмову про дизайн', 'Не вдалося завантажити розмови.', 'Розмови проєкту', 'Не вдалося завантажити розмову.', 'Завантаження розмов…', 'Повідомлень: {count}', 'Повідомлень: {count}', 'Для цього проєкту немає доступної розмови.', 'Картографічний проєкт', 'Розмову про дизайн згорнуто', 'Змінити розмір розмови про дизайн', 'Повторити', 'Виконання активне', 'Виконується', 'Запитана розмова недоступна. Показано найновішу розмову.'],
    workspace: ['Налаштуйте доступного локального агента, щоб використовувати цей робочий простір карти.', 'Не вдалося імпортувати карту.', 'Імпорт джерела карти…', 'Не вдалося завантажити цей робочий простір карти.', 'Завантаження робочого простору карти…', 'Відкрити налаштування', 'Повторити імпорт', 'Ця карта більше недоступна.'],
    navigation: ['Навігація картою', 'Збільшити', 'Зменшити', 'Знайти мене', 'Повернути компас на північ', 'Геолокація недоступна в цьому браузері.', 'Визначення вашого місцезнаходження…', 'Карту відцентровано на вашому місцезнаходженні.', 'Не вдалося отримати доступ до вашого місцезнаходження.'],
  },
  tr: {
    agent: ['Harita düzenleme kullanılamıyor', 'Herkese açık akıl yürütme özetleri kullanılabilir'],
    composer: ['Ekler kullanılamıyor', 'Göndermek için Enter’a basın', 'Harita aracısına mesaj gönder', 'Mesajlar {limit} karakterle sınırlıdır.', 'Harita değişikliğini açıklayın', 'Gönder', 'Çalıştırma eylemleri'],
    activity: ['Çalışıyor', 'Tamamlandı', 'Başarısız', 'İptal edildi', '{count} adım', '{count} adım', 'Ayrıntıları genişlet', 'Ayrıntıları daralt', 'Devam eden adım', 'Akıl yürütme özeti', 'Önceki araç adımları atlandı', 'Hazırlanıyor', 'Analiz ediliyor', 'Doğrulanıyor', 'Önizleme oluşturuluyor', 'Revizyon kaydediliyor', 'Düşünüyor', 'İstek özeti', 'Sonuç özeti', 'Harita bağlamını oku', 'Haritayı incele', 'Katmanları ara', 'Harita değişikliklerini uygula', 'Harita semantiğini güncelle', 'Haritayı doğrula', 'Önizlemeyi oluştur', 'Revizyonu kaydet', 'Taslağı sil', 'Araç etkinliği', 'Önceki {count} araç adımı atlandı', '{count} başarısız'],
    conversation: ['Çalıştırmayı iptal et', 'Harita tasarımı aracısı sohbeti', 'Sohbeti daralt', 'Konuşma oluşturulamadı.', 'Konuşma oluşturuluyor', 'Konuşma oluşturuluyor…', 'Yeni konuşma', 'Tasarım konuşmasını genişlet', 'Konuşmalar yüklenemedi.', 'Proje konuşmaları', 'Konuşma yüklenemedi.', 'Konuşmalar yükleniyor…', 'İleti: {count}', 'İleti: {count}', 'Bu proje için kullanılabilir konuşma yok.', 'Harita projesi', 'Tasarım konuşması daraltıldı', 'Tasarım konuşmasını yeniden boyutlandır', 'Yeniden dene', 'Çalıştırma etkin', 'Çalışıyor', 'İstenen konuşma kullanılamıyor. En yeni konuşma gösteriliyor.'],
    workspace: ['Bu harita çalışma alanını kullanmak için kullanılabilir bir yerel aracı yapılandırın.', 'Harita içe aktarılamadı.', 'Harita kaynağı içe aktarılıyor…', 'Bu harita çalışma alanı yüklenemedi.', 'Harita çalışma alanı yükleniyor…', 'Ayarları Aç', 'İçe aktarmayı yeniden dene', 'Bu harita artık kullanılamıyor.'],
    navigation: ['Harita gezintisi', 'Yakınlaştır', 'Uzaklaştır', 'Konumumu bul', 'Pusulayı kuzeye sıfırla', 'Bu tarayıcıda konum kullanılamıyor.', 'Konumunuz bulunuyor…', 'Harita konumunuza ortalandı.', 'Konumunuza erişilemedi.'],
  },
  th: {
    agent: ['ไม่สามารถแก้ไขแผนที่ได้', 'มีข้อมูลสรุปเหตุผลสาธารณะ'],
    composer: ['ไฟล์แนบไม่พร้อมใช้งาน', 'กด Enter เพื่อส่ง', 'ส่งข้อความถึงเอเจนต์แผนที่', 'ข้อความจำกัดที่ {limit} อักขระ', 'อธิบายการเปลี่ยนแปลงแผนที่', 'ส่ง', 'การดำเนินการ'],
    activity: ['กำลังทำงาน', 'เสร็จสิ้น', 'ล้มเหลว', 'ยกเลิกแล้ว', '{count} ขั้นตอน', '{count} ขั้นตอน', 'ขยายรายละเอียด', 'ยุบรายละเอียด', 'ขั้นตอนที่กำลังทำงาน', 'สรุปการให้เหตุผล', 'ละเว้นขั้นตอนเครื่องมือก่อนหน้า', 'กำลังเตรียม', 'กำลังวิเคราะห์', 'กำลังตรวจสอบ', 'กำลังแสดงตัวอย่าง', 'กำลังบันทึกรีวิชัน', 'กำลังคิด', 'สรุปคำขอ', 'สรุปผลลัพธ์', 'อ่านบริบทแผนที่', 'ตรวจสอบแผนที่', 'ค้นหาเลเยอร์', 'ใช้การเปลี่ยนแปลงแผนที่', 'อัปเดตความหมายของแผนที่', 'ตรวจสอบความถูกต้องของแผนที่', 'แสดงตัวอย่าง', 'บันทึกรีวิชัน', 'ละทิ้งแบบร่าง', 'กิจกรรมเครื่องมือ', 'ละเว้นขั้นตอนเครื่องมือก่อนหน้า {count} ขั้นตอน', 'ล้มเหลว {count} รายการ'],
    conversation: ['ยกเลิกการทำงาน', 'แชตกับเอเจนต์ออกแบบแผนที่', 'ยุบแชต', 'สร้างการสนทนาไม่ได้', 'กำลังสร้างการสนทนา', 'กำลังสร้างการสนทนา…', 'การสนทนาใหม่', 'ขยายการสนทนาด้านการออกแบบ', 'โหลดการสนทนาไม่ได้', 'การสนทนาของโปรเจกต์', 'โหลดการสนทนาไม่ได้', 'กำลังโหลดการสนทนา…', 'ข้อความ: {count}', 'ข้อความ: {count}', 'ไม่มีการสนทนาสำหรับโปรเจกต์นี้', 'โปรเจกต์แผนที่', 'ยุบการสนทนาด้านการออกแบบแล้ว', 'ปรับขนาดการสนทนาด้านการออกแบบ', 'ลองอีกครั้ง', 'กำลังทำงาน', 'กำลังทำงาน', 'การสนทนาที่ขอไม่พร้อมใช้งาน กำลังแสดงการสนทนาล่าสุด'],
    workspace: ['กำหนดค่าเอเจนต์ในเครื่องที่พร้อมใช้งานเพื่อใช้พื้นที่ทำงานแผนที่นี้', 'นำเข้าแผนที่ไม่สำเร็จ', 'กำลังนำเข้าแหล่งที่มาของแผนที่…', 'โหลดพื้นที่ทำงานแผนที่นี้ไม่ได้', 'กำลังโหลดพื้นที่ทำงานแผนที่…', 'เปิดการตั้งค่า', 'ลองนำเข้าอีกครั้ง', 'แผนที่นั้นไม่พร้อมใช้งานแล้ว'],
    navigation: ['การนำทางแผนที่', 'ซูมเข้า', 'ซูมออก', 'ค้นหาตำแหน่งของฉัน', 'รีเซ็ตเข็มทิศไปทางเหนือ', 'เบราว์เซอร์นี้ไม่รองรับตำแหน่งที่ตั้ง', 'กำลังค้นหาตำแหน่งของคุณ…', 'แผนที่จัดกึ่งกลางที่ตำแหน่งของคุณแล้ว', 'ไม่สามารถเข้าถึงตำแหน่งของคุณได้'],
  },
  it: {
    agent: ['La modifica della mappa non è disponibile', 'Sono disponibili riepiloghi pubblici del ragionamento'],
    composer: ['Allegati non disponibili', 'Premi Invio per inviare', 'Invia un messaggio all’agente cartografico', 'I messaggi sono limitati a {limit} caratteri.', 'Descrivi la modifica alla mappa', 'Invia', 'Azioni di esecuzione'],
    activity: ['In corso', 'Completato', 'Non riuscito', 'Annullato', '{count} passaggio', '{count} passaggi', 'Espandi dettagli', 'Comprimi dettagli', 'Passaggio in corso', 'Riepilogo del ragionamento', 'Passaggi precedenti dello strumento omessi', 'Preparazione', 'Analisi', 'Convalida', 'Rendering anteprima', 'Commit revisione', 'Ragionamento', 'Riepilogo richiesta', 'Riepilogo risultato', 'Leggi contesto mappa', 'Ispeziona mappa', 'Cerca livelli', 'Applica modifiche alla mappa', 'Aggiorna semantica mappa', 'Convalida mappa', 'Rendering anteprima', 'Commit revisione', 'Scarta bozza', 'Attività strumento', 'Omissi {count} passaggi precedenti dello strumento', '{count} non riusciti'],
    conversation: ['Annulla esecuzione', 'Chat con l’agente di progettazione mappe', 'Comprimi chat', 'Impossibile creare la conversazione.', 'Creazione conversazione', 'Creazione conversazione…', 'Nuova conversazione', 'Espandi conversazione di progettazione', 'Impossibile caricare le conversazioni.', 'Conversazioni del progetto', 'Impossibile caricare la conversazione.', 'Caricamento conversazioni…', 'Messaggi: {count}', 'Messaggi: {count}', 'Non sono disponibili conversazioni per questo progetto.', 'Progetto mappa', 'Conversazione di progettazione compressa', 'Ridimensiona conversazione di progettazione', 'Riprova', 'Esecuzione attiva', 'In esecuzione', 'La conversazione richiesta non è disponibile. Viene mostrata la conversazione più recente.'],
    workspace: ['Configura un agente locale disponibile per usare questa area di lavoro della mappa.', 'Importazione della mappa non riuscita.', 'Importazione sorgente mappa…', 'Impossibile caricare questa area di lavoro della mappa.', 'Caricamento area di lavoro della mappa…', 'Apri impostazioni', 'Riprova importazione', 'Questa mappa non è più disponibile.'],
    navigation: ['Navigazione mappa', 'Ingrandisci', 'Riduci', 'Trova la mia posizione', 'Reimposta la bussola a nord', 'La posizione non è disponibile in questo browser.', 'Ricerca della posizione…', 'Mappa centrata sulla tua posizione.', 'Impossibile accedere alla tua posizione.'],
  },
} satisfies Record<Locale, Copy>;

function workbench(locale: Locale, { agent, composer, activity, conversation, workspace, navigation }: Copy): WorkbenchDict {
  const revision = revisionCopy[locale];
  const runtime = runtimeCopy[locale];
  return {
    'mapDesign.agent.mapEditingUnavailable': agent[0],
    'mapDesign.agent.publicReasoningSummaryAvailable': agent[1],
    'mapDesign.runtime.change': runtime[0],
    'mapDesign.runtime.settings': runtime[1],
    'mapDesign.runtime.settingsHint': runtime[2],
    'mapDesign.runtime.agents': runtime[3],
    'mapDesign.runtime.models': runtime[4],
    'mapDesign.runtime.searchModels': runtime[5],
    'mapDesign.runtime.customModel': runtimeCustomModelCopy[locale][0],
    'mapDesign.runtime.customModelPlaceholder': runtimeCustomModelCopy[locale][1],
    'mapDesign.runtime.useCustomModel': runtimeCustomModelCopy[locale][2],
    'mapDesign.runtime.reasoning': runtime[6],
    'mapDesign.runtime.serviceTier': runtime[7],
    'mapDesign.runtime.default': runtimeDefaultCopy[locale],
    'mapDesign.runtime.agentUnavailable': runtime[8],
    'mapDesign.runtime.nativeToolsUnavailable': runtime[9],
    'mapDesign.runtime.policyUnsupported': runtime[10],
    'mapDesign.runtime.claudePolicyUnsupported': runtime[11],
    'mapDesign.runtime.catalogUnavailable': runtime[12],
    'mapDesign.runtime.modelUnavailable': runtime[13],
    'mapDesign.runtime.liveCatalog': runtime[14],
    'mapDesign.runtime.fallbackCatalog': runtime[15],
    'mapDesign.runtime.rememberedCatalog': runtime[16],
    'mapDesign.runtime.saving': runtime[17],
    'mapDesign.runtime.conflict': runtime[18],
    'mapDesign.runtime.normalized': runtime[19],
    'mapDesign.runtime.loadError': runtime[20],
    'mapDesign.runtime.saveError': runtime[21],
    'mapDesign.runtime.runActiveDisabled': runtime[22],
    'mapDesign.run.startError': runStartError[locale],
    'mapDesign.run.toolLoopDetected': runToolLoopDetected[locale],
    'mapDesign.composer.label': composer[2],
    'mapDesign.composer.limit': composer[3],
    'mapDesign.composer.placeholder': composer[4],
    'mapDesign.composer.send': composer[5],
    'mapDesign.composer.runActions': composer[6],
    'mapDesign.activity.working': activity[0],
    'mapDesign.activity.completed': activity[1],
    'mapDesign.activity.failed': activity[2],
    'mapDesign.activity.canceled': activity[3],
    'mapDesign.activity.stepCountOne': activity[4],
    'mapDesign.activity.stepCountMany': activity[5],
    'mapDesign.activity.expand': activity[6],
    'mapDesign.activity.collapse': activity[7],
    'mapDesign.activity.statusFallback': activity[8],
    'mapDesign.activity.summaryFallback': activity[9],
    'mapDesign.activity.toolsOmitted': activity[10],
    'mapDesign.activity.stagePreparing': activity[11],
    'mapDesign.activity.stageAnalyzing': activity[12],
    'mapDesign.activity.stageValidating': activity[13],
    'mapDesign.activity.stagePreviewing': activity[14],
    'mapDesign.activity.stageCommitting': activity[15],
    'mapDesign.activity.thinking': activity[16],
    'mapDesign.activity.requestSummary': activity[17],
    'mapDesign.activity.resultSummary': activity[18],
    'mapDesign.activity.toolGetContext': activity[19],
    'mapDesign.activity.toolInspect': activity[20],
    'mapDesign.activity.toolSearchLayers': activity[21],
    'mapDesign.activity.toolApplyTransaction': activity[22],
    'mapDesign.activity.toolUpdateSemantics': activity[23],
    'mapDesign.activity.toolValidate': activity[24],
    'mapDesign.activity.toolRenderPreview': activity[25],
    'mapDesign.activity.toolCommitRevision': activity[26],
    'mapDesign.activity.toolDiscardDraft': activity[27],
    'mapDesign.activity.toolGeneric': activity[28],
    'mapDesign.activity.toolsOmittedCount': activity[29],
    'mapDesign.activity.toolsOmittedFailures': activity[30],
    'mapDesign.conversation.cancelRun': conversation[0],
    'mapDesign.conversation.chatRegion': conversation[1],
    'mapDesign.conversation.collapse': conversation[2],
    'mapDesign.conversation.createError': conversation[3],
    'mapDesign.conversation.creating': conversation[4],
    'mapDesign.conversation.creatingStatus': conversation[5],
    'mapDesign.conversation.defaultTitle': conversation[6],
    'mapDesign.conversation.expand': conversation[7],
    'mapDesign.conversation.listError': conversation[8],
    'mapDesign.conversation.listLabel': conversation[9],
    'mapDesign.conversation.loadError': conversation[10],
    'mapDesign.conversation.loading': conversation[11],
    'mapDesign.conversation.messageCountMany': conversation[12],
    'mapDesign.conversation.messageCountOne': conversation[13],
    'mapDesign.conversation.none': conversation[14],
    'mapDesign.conversation.railCollapsed': conversation[16],
    'mapDesign.conversation.resize': conversation[17],
    'mapDesign.conversation.retry': conversation[18],
    'mapDesign.conversation.runActive': conversation[19],
    'mapDesign.conversation.running': conversation[20],
    'mapDesign.conversation.unavailableNotice': conversation[21],
    'mapDesign.workspace.agentUnavailable': workspace[0],
    'mapDesign.workspace.importFailed': workspace[1],
    'mapDesign.workspace.importing': workspace[2],
    'mapDesign.workspace.loadError': workspace[3],
    'mapDesign.workspace.loading': workspace[4],
    'mapDesign.workspace.openSettings': workspace[5],
    'mapDesign.workspace.retryImport': workspace[6],
    'mapDesign.workspace.unavailableProject': workspace[7],
    'mapDesign.studio.mapNavigation': navigation[0],
    'mapDesign.studio.zoomIn': navigation[1],
    'mapDesign.studio.zoomOut': navigation[2],
    'mapDesign.studio.locate': navigation[3],
    'mapDesign.studio.resetNorth': navigation[4],
    'mapDesign.studio.locationUnavailable': navigation[5],
    'mapDesign.studio.locationPending': navigation[6],
    'mapDesign.studio.locationSuccess': navigation[7],
    'mapDesign.studio.locationError': navigation[8],
    'mapDesign.revision.banner': revision[0],
    'mapDesign.revision.cancel': revision[1],
    'mapDesign.revision.composerReadOnly': revision[2],
    'mapDesign.revision.currentCommit': revision[3],
    'mapDesign.revision.historyPreserved': revision[4],
    'mapDesign.revision.historicalUnavailable': revision[5],
    'mapDesign.revision.restore': revision[6],
    'mapDesign.revision.restoreActiveRun': restoreActiveRun[locale],
    'mapDesign.revision.restoreConflict': revision[7],
    'mapDesign.revision.restoreDescription': revision[8],
    'mapDesign.revision.restoreFailed': revision[9],
    'mapDesign.revision.restoreSuccess': revision[10],
    'mapDesign.revision.restoreTitle': revision[11],
    'mapDesign.revision.restoring': revision[12],
    'mapDesign.revision.returnCurrent': revision[13],
    'mapDesign.revision.view': revision[14],
    'mapDesign.revision.viewing': revision[15],
  };
}

export const mapDesignWorkbench = Object.fromEntries(
  Object.entries(copy).map(([locale, values]) => [locale, workbench(locale as Locale, values)]),
) as Record<Locale, WorkbenchDict>;
