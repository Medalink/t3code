import { useEffect, useState } from "react";
import { I18nManager, Platform, Pressable, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AppText as Text } from "./AppText";
import { cn } from "../lib/cn";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

export function SegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.8;
  const compact = props.size === "compact";
  const count = Math.max(1, props.options.length);
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.selected),
  );
  const position = useSharedValue(index);
  useEffect(() => {
    position.set(
      withTiming(index, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [index, position]);
  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: ((position.value * width) / count) * (I18nManager.isRTL ? -1 : 1),
      },
    ],
  }));
  return (
    <View
      accessible={false}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      className={cn(
        stacked ? "overflow-hidden" : "flex-row overflow-hidden",
        "rounded-[22px] border-continuous bg-subtle",
        props.className,
      )}
    >
      {!stacked ? (
        <Animated.View
          pointerEvents="none"
          className="absolute inset-y-0 rounded-[22px] bg-primary"
          style={[{ width: `${100 / count}%`, start: 0 }, indicatorStyle]}
        />
      ) : null}
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole={Platform.OS === "ios" ? "button" : (props.role ?? "button")}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(option.value)}
            className={cn(
              "min-w-0 items-center justify-center rounded-[22px] px-2 py-2",
              !stacked && "flex-1",
              stacked && active && "bg-primary",
              compact ? "min-h-9 android:min-h-10" : "min-h-11",
            )}
          >
            <Text
              className={cn(
                compact ? "text-center text-xs" : "text-center text-sm",
                active ? "font-t3-medium text-primary-foreground" : "text-foreground-muted",
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
