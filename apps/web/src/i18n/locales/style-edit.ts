import type { MapStyleEditProperty } from '@mapseekai/map-design-contracts';
import type { Locale } from '../types';
import { styleControlWords } from './style-controls';
import { commentsCopy } from './comments';

export interface StyleEditCopy {
  edit: string; title: string; close: string; pickHint: string; emptyHit: string; chooseTarget: string;
  selectedTarget: string; scope: string; feature: string; similar: string; layer: string; property: string;
  save: string; saving: string; cancel: string; saveError: string; stale: string; featureUnavailable: string;
  controls: Partial<Record<MapStyleEditProperty, string>>;
}
type Own = Pick<StyleEditCopy, 'edit' | 'title' | 'close' | 'save' | 'saving' | 'saveError' | 'controls'>;
const c = (color: string, opacity: string, width: string, radius: string, textColor: string, textOpacity: string, textSize: string): Partial<Record<MapStyleEditProperty, string>> => ({
  'fill-color': color, 'fill-opacity': opacity, 'line-color': color, 'line-opacity': opacity, 'line-width': width,
  'circle-color': color, 'circle-opacity': opacity, 'circle-radius': radius,
  'text-color': textColor, 'text-opacity': textOpacity, 'text-size': textSize,
});

const own: Record<Locale, Own> = {
  en: { edit: 'Edit style', title: 'Style map feature', close: 'Close style editor', save: 'Save style', saving: 'Saving…', saveError: 'The style change could not be saved. Your edits are still here.', controls: c('Color', 'Opacity', 'Width', 'Radius', 'Text color', 'Text opacity', 'Text size') },
  id: { edit: 'Edit gaya', title: 'Atur gaya fitur peta', close: 'Tutup editor gaya', save: 'Simpan gaya', saving: 'Menyimpan…', saveError: 'Perubahan gaya tidak dapat disimpan. Edit Anda tetap tersedia.', controls: c('Warna', 'Opasitas', 'Lebar', 'Radius', 'Warna teks', 'Opasitas teks', 'Ukuran teks') },
  de: { edit: 'Stil bearbeiten', title: 'Kartenobjekt gestalten', close: 'Stileditor schließen', save: 'Stil speichern', saving: 'Speichern…', saveError: 'Die Stiländerung konnte nicht gespeichert werden. Ihre Änderungen bleiben erhalten.', controls: c('Farbe', 'Deckkraft', 'Breite', 'Radius', 'Textfarbe', 'Textdeckkraft', 'Textgröße') },
  'zh-CN': { edit: '编辑样式', title: '设置地图要素样式', close: '关闭样式编辑器', save: '保存样式', saving: '正在保存…', saveError: '无法保存样式更改，编辑内容仍然保留。', controls: c('颜色', '不透明度', '宽度', '半径', '文字颜色', '文字不透明度', '文字大小') },
  'zh-TW': { edit: '編輯樣式', title: '設定地圖圖徵樣式', close: '關閉樣式編輯器', save: '儲存樣式', saving: '正在儲存…', saveError: '無法儲存樣式變更，編輯內容仍會保留。', controls: c('顏色', '不透明度', '寬度', '半徑', '文字顏色', '文字不透明度', '文字大小') },
  'pt-BR': { edit: 'Editar estilo', title: 'Estilizar elemento do mapa', close: 'Fechar editor de estilo', save: 'Salvar estilo', saving: 'Salvando…', saveError: 'Não foi possível salvar a alteração de estilo. Suas edições continuam aqui.', controls: c('Cor', 'Opacidade', 'Largura', 'Raio', 'Cor do texto', 'Opacidade do texto', 'Tamanho do texto') },
  'es-ES': { edit: 'Editar estilo', title: 'Dar estilo al elemento del mapa', close: 'Cerrar editor de estilo', save: 'Guardar estilo', saving: 'Guardando…', saveError: 'No se pudo guardar el cambio de estilo. Tus cambios siguen aquí.', controls: c('Color', 'Opacidad', 'Anchura', 'Radio', 'Color del texto', 'Opacidad del texto', 'Tamaño del texto') },
  ru: { edit: 'Изменить стиль', title: 'Стиль объекта карты', close: 'Закрыть редактор стиля', save: 'Сохранить стиль', saving: 'Сохранение…', saveError: 'Не удалось сохранить изменение стиля. Правки остаются в редакторе.', controls: c('Цвет', 'Непрозрачность', 'Ширина', 'Радиус', 'Цвет текста', 'Непрозрачность текста', 'Размер текста') },
  fa: { edit: 'ویرایش سبک', title: 'سبک‌دهی عارضهٔ نقشه', close: 'بستن ویرایشگر سبک', save: 'ذخیرهٔ سبک', saving: 'در حال ذخیره…', saveError: 'تغییر سبک ذخیره نشد. ویرایش‌های شما همچنان باقی است.', controls: c('رنگ', 'شفافیت', 'عرض', 'شعاع', 'رنگ متن', 'شفافیت متن', 'اندازهٔ متن') },
  ar: { edit: 'تعديل النمط', title: 'تنسيق معلم الخريطة', close: 'إغلاق محرر النمط', save: 'حفظ النمط', saving: 'جارٍ الحفظ…', saveError: 'تعذّر حفظ تغيير النمط. لا تزال تعديلاتك موجودة.', controls: c('اللون', 'التعتيم', 'العرض', 'نصف القطر', 'لون النص', 'تعتيم النص', 'حجم النص') },
  ja: { edit: 'スタイルを編集', title: '地物のスタイル', close: 'スタイルエディターを閉じる', save: 'スタイルを保存', saving: '保存中…', saveError: 'スタイルの変更を保存できませんでした。編集内容は保持されています。', controls: c('色', '不透明度', '幅', '半径', 'テキストの色', 'テキストの不透明度', 'テキストサイズ') },
  ko: { edit: '스타일 편집', title: '지도 피처 스타일', close: '스타일 편집기 닫기', save: '스타일 저장', saving: '저장 중…', saveError: '스타일 변경을 저장할 수 없습니다. 편집 내용은 그대로 유지됩니다.', controls: c('색상', '불투명도', '너비', '반지름', '텍스트 색상', '텍스트 불투명도', '텍스트 크기') },
  pl: { edit: 'Edytuj styl', title: 'Styl obiektu mapy', close: 'Zamknij edytor stylu', save: 'Zapisz styl', saving: 'Zapisywanie…', saveError: 'Nie udało się zapisać zmiany stylu. Twoje zmiany pozostają w edytorze.', controls: c('Kolor', 'Krycie', 'Szerokość', 'Promień', 'Kolor tekstu', 'Krycie tekstu', 'Rozmiar tekstu') },
  hu: { edit: 'Stílus szerkesztése', title: 'Térképelem stílusa', close: 'Stílusszerkesztő bezárása', save: 'Stílus mentése', saving: 'Mentés…', saveError: 'A stílusmódosítás nem menthető. A szerkesztések megmaradtak.', controls: c('Szín', 'Átlátszatlanság', 'Szélesség', 'Sugár', 'Szövegszín', 'Szöveg átlátszatlansága', 'Szövegméret') },
  fr: { edit: 'Modifier le style', title: 'Styliser l’entité cartographique', close: 'Fermer l’éditeur de style', save: 'Enregistrer le style', saving: 'Enregistrement…', saveError: 'La modification du style n’a pas pu être enregistrée. Vos changements sont conservés.', controls: c('Couleur', 'Opacité', 'Largeur', 'Rayon', 'Couleur du texte', 'Opacité du texte', 'Taille du texte') },
  uk: { edit: 'Змінити стиль', title: 'Стиль об’єкта мапи', close: 'Закрити редактор стилю', save: 'Зберегти стиль', saving: 'Збереження…', saveError: 'Не вдалося зберегти зміну стилю. Ваші правки залишилися.', controls: c('Колір', 'Непрозорість', 'Ширина', 'Радіус', 'Колір тексту', 'Непрозорість тексту', 'Розмір тексту') },
  tr: { edit: 'Stili düzenle', title: 'Harita detayını biçimlendir', close: 'Stil düzenleyiciyi kapat', save: 'Stili kaydet', saving: 'Kaydediliyor…', saveError: 'Stil değişikliği kaydedilemedi. Düzenlemeleriniz korunuyor.', controls: c('Renk', 'Opaklık', 'Genişlik', 'Yarıçap', 'Metin rengi', 'Metin opaklığı', 'Metin boyutu') },
  th: { edit: 'แก้ไขสไตล์', title: 'กำหนดสไตล์ฟีเจอร์แผนที่', close: 'ปิดตัวแก้ไขสไตล์', save: 'บันทึกสไตล์', saving: 'กำลังบันทึก…', saveError: 'บันทึกการเปลี่ยนสไตล์ไม่ได้ การแก้ไขของคุณยังคงอยู่', controls: c('สี', 'ความทึบ', 'ความกว้าง', 'รัศมี', 'สีข้อความ', 'ความทึบข้อความ', 'ขนาดข้อความ') },
  it: { edit: 'Modifica stile', title: 'Stile dell’elemento della mappa', close: 'Chiudi editor di stile', save: 'Salva stile', saving: 'Salvataggio…', saveError: 'Impossibile salvare la modifica dello stile. Le modifiche restano disponibili.', controls: c('Colore', 'Opacità', 'Larghezza', 'Raggio', 'Colore del testo', 'Opacità del testo', 'Dimensione del testo') },
};

export const styleEditCopy = Object.fromEntries(Object.entries(own).map(([locale, translated]) => {
  const shared = commentsCopy[locale as Locale];
  return [locale, { ...translated, pickHint: shared.pickHint, emptyHit: shared.emptyHit, chooseTarget: shared.chooseTarget,
    selectedTarget: shared.selectedTarget, scope: shared.scope, feature: shared.feature, similar: shared.similar,
    layer: shared.layer, property: shared.property, cancel: shared.cancel, stale: shared.stale,
    featureUnavailable: shared.featureUnavailable }];
})) as Record<Locale, StyleEditCopy>;

export function styleControlLabel(locale: Locale, property: MapStyleEditProperty): string {
  const translated = styleEditCopy[locale].controls;
  if (translated[property]) return translated[property]!;
  const words = styleControlWords[locale];
  const suffix = property.replace(/^(fill-extrusion|fill|line|circle|symbol|text|icon)-/, '');
  const terms: Record<string, string> = {
    color: translated['fill-color']!, opacity: translated['fill-opacity']!, width: translated['line-width']!,
    'outline-color': words.outlineColor, 'stroke-color': words.outlineColor, 'stroke-width': words.outlineWidth,
    'stroke-opacity': words.outlineOpacity, antialias: words.antialias, translate: words.translate,
    'translate-anchor': words.translateAnchor, 'gap-width': words.gapWidth, offset: words.offset, blur: words.blur,
    dasharray: words.dasharray, cap: words.cap, join: words.join, 'miter-limit': words.miterLimit, 'round-limit': words.roundLimit,
    'pitch-alignment': words.pitchAlignment, 'pitch-scale': words.pitchScale, 'halo-color': words.haloColor,
    'halo-width': words.haloWidth, 'halo-blur': words.haloBlur, rotate: words.rotate, 'letter-spacing': words.letterSpacing,
    'max-width': words.maxWidth, 'line-height': words.lineHeight, anchor: words.anchor, justify: words.justify,
    transform: words.transform, 'allow-overlap': words.allowOverlap, 'ignore-placement': words.ignorePlacement,
    size: words.size, placement: words.placement, spacing: words.spacing, height: words.height, base: words.base,
    'vertical-gradient': words.verticalGradient, visibility: words.visibility,
  };
  const prefix = property.startsWith('text-') ? words.text : property.startsWith('icon-') ? words.icon : '';
  return prefix ? `${prefix} · ${terms[suffix] ?? property}` : terms[suffix] ?? property;
}
