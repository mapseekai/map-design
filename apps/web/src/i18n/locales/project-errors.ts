import type { Locale } from "../types";

export const projectErrorsCopy: Record<Locale, { load: string; retry: string; remove: string }> = {
  en: { load: "Unable to load projects. Please try again.", retry: "Unable to retry import. Please try again.", remove: "Unable to delete project. Please try again." },
  "zh-CN": { load: "无法加载项目，请重试。", retry: "无法重试导入，请重试。", remove: "无法删除项目，请重试。" },
  "zh-TW": { load: "無法載入專案，請重試。", retry: "無法重試匯入，請重試。", remove: "無法刪除專案，請重試。" },
  de: { load: "Projekte konnten nicht geladen werden. Bitte erneut versuchen.", retry: "Der Import konnte nicht erneut gestartet werden. Bitte erneut versuchen.", remove: "Das Projekt konnte nicht gelöscht werden. Bitte erneut versuchen." },
  fr: { load: "Impossible de charger les projets. Réessayez.", retry: "Impossible de relancer l’importation. Réessayez.", remove: "Impossible de supprimer le projet. Réessayez." },
  "es-ES": { load: "No se pudieron cargar los proyectos. Inténtalo de nuevo.", retry: "No se pudo reintentar la importación. Inténtalo de nuevo.", remove: "No se pudo eliminar el proyecto. Inténtalo de nuevo." },
  "pt-BR": { load: "Não foi possível carregar os projetos. Tente novamente.", retry: "Não foi possível repetir a importação. Tente novamente.", remove: "Não foi possível excluir o projeto. Tente novamente." },
  it: { load: "Impossibile caricare i progetti. Riprova.", retry: "Impossibile ripetere l’importazione. Riprova.", remove: "Impossibile eliminare il progetto. Riprova." },
  ja: { load: "プロジェクトを読み込めませんでした。再試行してください。", retry: "インポートを再試行できませんでした。再試行してください。", remove: "プロジェクトを削除できませんでした。再試行してください。" },
  ko: { load: "프로젝트를 불러오지 못했습니다. 다시 시도하세요.", retry: "가져오기를 다시 시도하지 못했습니다. 다시 시도하세요.", remove: "프로젝트를 삭제하지 못했습니다. 다시 시도하세요." },
  id: { load: "Proyek tidak dapat dimuat. Coba lagi.", retry: "Impor tidak dapat diulang. Coba lagi.", remove: "Proyek tidak dapat dihapus. Coba lagi." },
  ru: { load: "Не удалось загрузить проекты. Повторите попытку.", retry: "Не удалось повторить импорт. Повторите попытку.", remove: "Не удалось удалить проект. Повторите попытку." },
  uk: { load: "Не вдалося завантажити проєкти. Спробуйте ще раз.", retry: "Не вдалося повторити імпорт. Спробуйте ще раз.", remove: "Не вдалося видалити проєкт. Спробуйте ще раз." },
  pl: { load: "Nie udało się wczytać projektów. Spróbuj ponownie.", retry: "Nie udało się ponowić importu. Spróbuj ponownie.", remove: "Nie udało się usunąć projektu. Spróbuj ponownie." },
  hu: { load: "A projektek betöltése sikertelen. Próbálja újra.", retry: "Az importálás újrapróbálása sikertelen. Próbálja újra.", remove: "A projekt törlése sikertelen. Próbálja újra." },
  tr: { load: "Projeler yüklenemedi. Tekrar deneyin.", retry: "İçe aktarma yeniden denenemedi. Tekrar deneyin.", remove: "Proje silinemedi. Tekrar deneyin." },
  th: { load: "ไม่สามารถโหลดโครงการได้ โปรดลองอีกครั้ง", retry: "ไม่สามารถลองนำเข้าใหม่ได้ โปรดลองอีกครั้ง", remove: "ไม่สามารถลบโครงการได้ โปรดลองอีกครั้ง" },
  ar: { load: "تعذر تحميل المشاريع. حاول مجددًا.", retry: "تعذرت إعادة محاولة الاستيراد. حاول مجددًا.", remove: "تعذر حذف المشروع. حاول مجددًا." },
  fa: { load: "بارگذاری پروژه‌ها انجام نشد. دوباره تلاش کنید.", retry: "تلاش مجدد برای وارد کردن انجام نشد. دوباره تلاش کنید.", remove: "حذف پروژه انجام نشد. دوباره تلاش کنید." },
};
