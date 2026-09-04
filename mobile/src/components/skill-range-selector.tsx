import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppIcon } from '@/components/ui/app-ui';
import { skillLevels, skillRangeFromIndex, skillRangeIncludesIndex, skillRangeLabel, type SkillRange } from '@/lib/skill-range';
import { colors, radius, shadow, space } from '@/theme';

export function SkillRangeSelector({ value, onChange, label = 'Trình độ phù hợp', helperText }: { value: SkillRange; onChange: (range: SkillRange) => void; label?: string; helperText?: string }) {
  const [open, setOpen] = useState(false); const [draft, setDraft] = useState<SkillRange>(value);
  const apply = () => { onChange(draft); setOpen(false); };
  return <View style={styles.wrap}>
    <Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${skillRangeLabel(value)}`} onPress={() => { setDraft(value); setOpen(true); }} style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
      <Text style={styles.triggerText}>{skillRangeLabel(value)}</Text><Text style={styles.chevron}>›</Text>
    </Pressable>
    {helperText ? <Text style={styles.helper}>{helperText}</Text> : null}
    <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.indicator} />
          <Text style={styles.title}>Chọn trình độ phù hợp</Text>
          <Text style={styles.subtitle}>Người chơi ngoài khoảng này vẫn có thể gửi yêu cầu tham gia. HOST là người quyết định.</Text>
          <Pressable onPress={() => setDraft(null)} style={({ pressed }) => [styles.allRow, pressed && styles.pressed]}>
            <View style={[styles.check, !draft && styles.checkActive]}>{!draft ? <AppIcon name="check" size={18} color="#fff" /> : null}</View>
            <Text style={styles.allText}>Tất cả trình độ</Text>
          </Pressable>
          <View style={styles.levels}>{skillLevels.map((level, index) => {
            const selected = skillRangeIncludesIndex(draft, index);
            return <Pressable key={level.label} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => setDraft((current) => skillRangeFromIndex(current, index))} style={({ pressed }) => [styles.levelRow, pressed && styles.pressed]}>
              <View style={[styles.check, selected && styles.checkActive]}>{selected ? <AppIcon name="check" size={18} color="#fff" /> : null}</View><Text style={styles.levelText}>{level.label}</Text>
            </Pressable>;
          })}</View>
          <View style={styles.actions}><Pressable onPress={() => setDraft(null)} style={styles.clearButton}><Text style={styles.clearText}>XÓA LỰA CHỌN</Text></Pressable><Pressable onPress={apply} style={styles.applyButton}><Text style={styles.applyText}>ÁP DỤNG</Text></Pressable></View>
        </View>
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 7 }, label: { color: colors.text, fontWeight: '800', fontSize: 14 }, trigger: { minHeight: 52, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.input, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, triggerText: { color: colors.text, fontSize: 15, fontWeight: '700' }, chevron: { color: colors.brand, fontSize: 28, lineHeight: 28 }, helper: { color: colors.muted, fontSize: 12, lineHeight: 17 }, overlay: { flex: 1, justifyContent: Platform.select({ web: 'center', default: 'flex-end' }), backgroundColor: 'rgba(18, 33, 26, 0.42)', padding: Platform.select({ web: space.lg, default: 0 }) }, sheet: { width: '100%', maxWidth: Platform.select({ web: 440, default: undefined }), alignSelf: 'center', backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, borderBottomLeftRadius: Platform.select({ web: 24, default: 0 }), borderBottomRightRadius: Platform.select({ web: 24, default: 0 }), padding: space.lg, gap: 10, ...(Platform.OS === 'web' ? shadow : {}) }, indicator: { width: 42, height: 5, borderRadius: radius.pill, backgroundColor: '#D9E1DC', alignSelf: 'center', marginBottom: 4 }, title: { color: colors.text, fontSize: 20, fontWeight: '900' }, subtitle: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 3 }, allRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }, allText: { color: colors.brandStrong, fontWeight: '800', fontSize: 15 }, levels: { gap: 0 }, levelRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12 }, check: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: '#B8C5BD', alignItems: 'center', justifyContent: 'center' }, checkActive: { backgroundColor: colors.brand, borderColor: colors.brand }, levelText: { color: colors.text, fontSize: 15, fontWeight: '600' }, actions: { flexDirection: 'row', gap: 10, paddingTop: 7 }, clearButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 }, clearText: { color: colors.brand, fontSize: 12, fontWeight: '900' }, applyButton: { minHeight: 48, flex: 1, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand }, applyText: { color: '#fff', fontSize: 13, fontWeight: '900' }, pressed: { opacity: 0.72 },
});
