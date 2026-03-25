export function mapToChart(data: any[], llmResponse: any) {
  const { chart_type, x_axis, y_axis, title } = llmResponse;

  if (!data || data.length === 0) {
    return {
      type: "empty",
      spec: null,
      message: "No data returned from the query."
    };
  }

  // Graceful fallback if mapping isn't cleanly supported
  if (chart_type === "table") {
    return { type: "table", spec: null, data };
  }

  // Common VChart configuration shell
  const baseSpec: any = {
    type: chart_type,
    data: [
      {
        id: "id0",
        values: data,
      },
    ],
    title: {
      visible: true,
      text: title,
    },
    legends: [{ visible: true, positon: "bottom" }],
  };

  if (chart_type === "bar" || chart_type === "line" || chart_type === "area") {
    baseSpec.xField = x_axis;
    baseSpec.yField = y_axis;
  } else if (chart_type === "pie") {
    baseSpec.categoryField = x_axis;
    baseSpec.valueField = y_axis;
  } else if (chart_type === "scatter") {
    baseSpec.xField = x_axis;
    baseSpec.yField = y_axis;
    baseSpec.sizeField = y_axis; // Optional visual tuning
  }

  return { type: "chart", spec: baseSpec, data };
}
