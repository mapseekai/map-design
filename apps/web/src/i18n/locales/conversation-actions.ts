import type { Locale } from '../types';

export const conversationActionsCopy: Record<Locale, { delete: string; description: string; cancel: string; error: string; running: string }> = {
  "en": {
    "delete": "Delete conversation",
    "description": "This conversation and its messages will be permanently deleted. The map and revisions will remain.",
    "cancel": "Cancel",
    "error": "Could not delete this conversation. Please try again.",
    "running": "Stop the active run before deleting this conversation."
  },
  "zh-CN": {
    "delete": "删除对话",
    "description": "将永久删除此对话及其消息，地图和修订版本会保留。",
    "cancel": "取消",
    "error": "删除对话失败，请重试。",
    "running": "请先停止运行中的任务，再删除此对话。"
  },
  "zh-TW": {
    "delete": "刪除對話",
    "description": "將永久刪除此對話及其訊息，地圖和修訂版本會保留。",
    "cancel": "取消",
    "error": "刪除對話失敗，請重試。",
    "running": "請先停止執行中的任務，再刪除此對話。"
  },
  "de": {
    "delete": "Unterhaltung löschen",
    "description": "Diese Unterhaltung und ihre Nachrichten werden dauerhaft gelöscht. Karte und Revisionen bleiben erhalten.",
    "cancel": "Abbrechen",
    "error": "Die Unterhaltung konnte nicht gelöscht werden. Bitte erneut versuchen.",
    "running": "Beenden Sie zuerst den aktiven Lauf."
  },
  "fr": {
    "delete": "Supprimer la conversation",
    "description": "Cette conversation et ses messages seront supprimés définitivement. La carte et les révisions seront conservées.",
    "cancel": "Annuler",
    "error": "Impossible de supprimer la conversation. Réessayez.",
    "running": "Arrêtez l’exécution en cours avant de supprimer la conversation."
  },
  "es-ES": {
    "delete": "Eliminar conversación",
    "description": "Se eliminarán permanentemente esta conversación y sus mensajes. El mapa y las revisiones se conservarán.",
    "cancel": "Cancelar",
    "error": "No se pudo eliminar la conversación. Inténtalo de nuevo.",
    "running": "Detén la ejecución activa antes de eliminar la conversación."
  },
  "pt-BR": {
    "delete": "Excluir conversa",
    "description": "Esta conversa e suas mensagens serão excluídas permanentemente. O mapa e as revisões serão mantidos.",
    "cancel": "Cancelar",
    "error": "Não foi possível excluir a conversa. Tente novamente.",
    "running": "Interrompa a execução ativa antes de excluir a conversa."
  },
  "it": {
    "delete": "Elimina conversazione",
    "description": "Questa conversazione e i suoi messaggi saranno eliminati definitivamente. La mappa e le revisioni saranno conservate.",
    "cancel": "Annulla",
    "error": "Impossibile eliminare la conversazione. Riprova.",
    "running": "Interrompi l’esecuzione attiva prima di eliminare la conversazione."
  },
  "ja": {
    "delete": "会話を削除",
    "description": "この会話とメッセージは完全に削除されます。地図とリビジョンは保持されます。",
    "cancel": "キャンセル",
    "error": "会話を削除できませんでした。もう一度お試しください。",
    "running": "実行中のタスクを停止してから会話を削除してください。"
  },
  "ko": {
    "delete": "대화 삭제",
    "description": "이 대화와 메시지가 영구적으로 삭제됩니다. 지도와 수정 버전은 유지됩니다.",
    "cancel": "취소",
    "error": "대화를 삭제하지 못했습니다. 다시 시도하세요.",
    "running": "실행 중인 작업을 중지한 후 대화를 삭제하세요."
  },
  "id": {
    "delete": "Hapus percakapan",
    "description": "Percakapan ini dan pesannya akan dihapus permanen. Peta dan revisi tetap disimpan.",
    "cancel": "Batal",
    "error": "Percakapan tidak dapat dihapus. Coba lagi.",
    "running": "Hentikan proses aktif sebelum menghapus percakapan."
  },
  "ru": {
    "delete": "Удалить диалог",
    "description": "Диалог и его сообщения будут удалены навсегда. Карта и версии сохранятся.",
    "cancel": "Отмена",
    "error": "Не удалось удалить диалог. Попробуйте снова.",
    "running": "Остановите активное выполнение перед удалением диалога."
  },
  "uk": {
    "delete": "Видалити розмову",
    "description": "Розмову та її повідомлення буде видалено назавжди. Карта та версії залишаться.",
    "cancel": "Скасувати",
    "error": "Не вдалося видалити розмову. Спробуйте знову.",
    "running": "Зупиніть активне виконання перед видаленням розмови."
  },
  "pl": {
    "delete": "Usuń rozmowę",
    "description": "Rozmowa i jej wiadomości zostaną trwale usunięte. Mapa i wersje zostaną zachowane.",
    "cancel": "Anuluj",
    "error": "Nie udało się usunąć rozmowy. Spróbuj ponownie.",
    "running": "Zatrzymaj aktywne zadanie przed usunięciem rozmowy."
  },
  "hu": {
    "delete": "Beszélgetés törlése",
    "description": "A beszélgetés és üzenetei végleg törlődnek. A térkép és a verziók megmaradnak.",
    "cancel": "Mégse",
    "error": "Nem sikerült törölni a beszélgetést. Próbálja újra.",
    "running": "Törlés előtt állítsa le a futó feladatot."
  },
  "tr": {
    "delete": "Sohbeti sil",
    "description": "Bu sohbet ve mesajları kalıcı olarak silinecek. Harita ve sürümler korunacak.",
    "cancel": "İptal",
    "error": "Sohbet silinemedi. Tekrar deneyin.",
    "running": "Sohbeti silmeden önce çalışan görevi durdurun."
  },
  "th": {
    "delete": "ลบการสนทนา",
    "description": "การสนทนาและข้อความนี้จะถูกลบอย่างถาวร แผนที่และรุ่นแก้ไขจะยังคงอยู่",
    "cancel": "ยกเลิก",
    "error": "ไม่สามารถลบการสนทนาได้ โปรดลองอีกครั้ง",
    "running": "หยุดงานที่กำลังทำงานก่อนลบการสนทนา"
  },
  "ar": {
    "delete": "حذف المحادثة",
    "description": "ستُحذف هذه المحادثة ورسائلها نهائيًا. ستبقى الخريطة والمراجعات.",
    "cancel": "إلغاء",
    "error": "تعذر حذف المحادثة. حاول مجددًا.",
    "running": "أوقف المهمة الجارية قبل حذف المحادثة."
  },
  "fa": {
    "delete": "حذف گفتگو",
    "description": "این گفتگو و پیام‌هایش برای همیشه حذف می‌شوند. نقشه و نسخه‌ها باقی می‌مانند.",
    "cancel": "لغو",
    "error": "حذف گفتگو انجام نشد. دوباره تلاش کنید.",
    "running": "پیش از حذف گفتگو، اجرای فعال را متوقف کنید."
  }
};
