{% macro union_tenant_tables(schema, entity_suffix) %}
    
    {%- set tables = dbt_utils.get_relations_by_pattern(
        schema_filter=schema,
        table_pattern='tenant_%_' + entity_suffix
    ) -%}

    {% for table in tables %}
        SELECT 
            *,
            -- Extract tenant_id from table name
            splitByChar('_', '{{ table.identifier }}')[2] as tenant_id
        FROM {{ table }}
        {% if not loop.last %} UNION ALL {% endif %}
    {% endfor %}

{% endmacro %}
