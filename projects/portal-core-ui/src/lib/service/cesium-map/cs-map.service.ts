import { CSWRecordModel } from '../../model/data/cswrecord.model';
import { Injectable, Inject } from '@angular/core';
import * as olExtent from 'ol/extent';
import olLayerVector from 'ol/layer/Vector';
import olLayer from 'ol/layer/Layer';
import olFeature from 'ol/Feature';
import * as olProj from 'ol/proj';
import {BehaviorSubject, Subject } from 'rxjs';
import { point } from '@turf/helpers';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import bboxPolygon from '@turf/bbox-polygon';
import { LayerModel } from '../../model/data/layer.model';
import { LayerHandlerService } from '../cswrecords/layer-handler.service';
import { ManageStateService } from '../permanentlink/manage-state.service';
import { CsCSWService } from '../wcsw/cs-csw.service';
import { CsWFSService } from '../wfs/cs-wfs.service';
import { CsMapObject } from './cs-map-object';
import { CsWMSService } from '../wms/cs-wms.service';
import { CsWWWService } from '../www/cs-www.service';
import { ResourceType } from '../../utility/constants.service';
import { CsIrisService } from '../kml/cs-iris.service';
import { MapsManagerService, RectangleEditorObservable, EventRegistrationInput, CesiumEvent, PickOptions, EventResult } from 'angular-cesium';
import { ProviderViewModel, buildModuleUrl, OpenStreetMapImageryProvider, BingMapsStyle,
   BingMapsImageryProvider, ArcGisMapServerImageryProvider, TileMapServiceImageryProvider, ImagerySplitDirection } from 'cesium';

/**
 * Wrapper class to provide all things related to the drawing of polygons and bounding boxes in CesiumJS
 */
@Injectable()
export class CsMapService {

  // VT: a storage to keep track of the layers that have been added to the map. This is use to handle click events.
  private layerModelList: { [key: string]: LayerModel; } = {};
  private addLayerSubject: Subject<LayerModel>;

  private clickedLayerListBS = new BehaviorSubject<any>({});
  // Cesium map
  private map;

  // If the split map pane is visible or not
  private splitMapShown = false;

  constructor(private layerHandlerService: LayerHandlerService, private csWMSService: CsWMSService,
    private csWFSService: CsWFSService, private csMapObject: CsMapObject, private manageStateService: ManageStateService,
    private csCSWService: CsCSWService, private csWWWService: CsWWWService, 
    private csIrisService: CsIrisService, private mapsManagerService: MapsManagerService,
    @Inject('env') private env, @Inject('conf') private conf)  {
    this.csMapObject.registerClickHandler(this.mapClickHandler.bind(this));
    this.addLayerSubject = new Subject<LayerModel>();
  }

  init() {
    this.map = this.mapsManagerService.getMap();
    const eventRegistration: EventRegistrationInput = {
      event: CesiumEvent.LEFT_CLICK, // Left mouse click
      pick: PickOptions.PICK_ONE // If lots of things are picked a 'picker' will help you choose one
    };
    const mapEventManager = this.mapsManagerService.getMap().getMapEventsManager();
    const clickEvent = mapEventManager.register(eventRegistration).subscribe((result) => {
      this.mapClickHandler(result);
    });
  }

  /**
   * get a observable subject that triggers an event whenever a map is clicked on
   * @returns the observable subject that returns the list of map layers that was clicked on in the format {clickedFeatureList,
   *         clickedLayerList, pixel,clickCoord}
   */
   public getClickedLayerListBS(): BehaviorSubject<any> {
     return this.clickedLayerListBS;
   }

   /**
    * Gets called when a map click event is recognised
    * @param pixel coordinates of clicked on pixel (units: pixels)
    */
   public mapClickHandler(eventResult: EventResult) {
      try {
           const pixel = eventResult.movement.startPosition;
           // Convert pixel coords to map coords
           const clickCoord = []; // FIXME this.map.getCoordinateFromPixel(pixel);
           const lonlat = olProj.transform(clickCoord, 'EPSG:3857', 'EPSG:4326');
           const clickPoint = point(lonlat);

           // Compile a list of clicked on layers
           const activeLayers = [] // this.map.getLayers(); // FIXME
           const clickedLayerList: olLayer[] = [];
           const layerColl = this.map.getLayers(); // FIXME
           const me = this;
           layerColl.forEach(function(layer) {
               for (const layerId in activeLayers) {
                   for (const activeLayer of activeLayers[layerId]) {
                       if (layer === activeLayer) {
                           const layerModel = me.getLayerModel(layerId);
                           if (!me.layerHandlerService.contains(layerModel, ResourceType.WMS)) {
                             continue;
                           }
                           const bbox = activeLayer.onlineResource.geographicElements[0];
                           const poly = bboxPolygon([bbox.westBoundLongitude, bbox.southBoundLatitude, bbox.eastBoundLongitude, bbox.northBoundLatitude]);
                           if (booleanPointInPolygon(clickPoint, poly) && !clickedLayerList.includes(activeLayer)) {
                             // Add to list of clicked layers
                             clickedLayerList.push(activeLayer);
                           }
                       }
                   }
               }
           }, me);

           // Compile a list of clicked on features
           const clickedFeatureList: olFeature[] = [];
           /*const featureHit = this.map.forEachFeatureAtPixel(pixel, function(feature) {  // FIXME
              // LJ: skip the olFeature
              if (feature.get('bClipboardVector')) {
                return;
              }
              clickedFeatureList.push(feature);
           });*/

           this.clickedLayerListBS.next({
             clickedFeatureList: clickedFeatureList,
             clickedLayerList: clickedLayerList,
             pixel: pixel,
             clickCoord: clickCoord
           });
      } catch (error) {
        throw error;
      }
   }

  /*
   * Return a list of CSWRecordModels present in active layers that intersect
   * the supplied extent
   *
   * @param extent the extent with which to test the intersection of CSW
   * records
   */
  public getCSWRecordsForExtent(extent: olExtent): CSWRecordModel[] {
    const intersectedCSWRecordList: CSWRecordModel[] = [];
    extent = olProj.transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
    const groupLayers = [] // this.map.getLayers(); // FIXME
    const mapLayerColl = []; // this.map.getLayers(); // FIXME
    const me = this;
    mapLayerColl.forEach(function(layer) {
       for (const layerId in groupLayers) {
           for (const activeLayer of groupLayers[layerId]) {
               if (layer === activeLayer) {
                   const layerModel = me.getLayerModel(layerId);
                   /*
                   if (!layerModel || !me.layerHandlerService.containsWMS(layerModel)) {
                      continue;
                   }
                   */
                   for (const cswRecord of layerModel.cswRecords) {
                       let cswRecordIntersects: boolean = false;
                       for (const bbox of cswRecord.geographicElements) {
                           const tBbox = [bbox.westBoundLongitude, bbox.southBoundLatitude, bbox.eastBoundLongitude, bbox.northBoundLatitude];
                           if (olExtent.intersects(extent, tBbox)) {
                               cswRecordIntersects = true;
                           }
                       }
                       if (cswRecordIntersects) {
                           intersectedCSWRecordList.push(cswRecord);
                       }
                   }
               }
           }
        }
     });

     return intersectedCSWRecordList;
  }

  /**
   * Add layer to the wms
   * @param layer the layer to add to the map
   */
  public addLayer(layer: LayerModel, param: any): void {
    // initiate csLayers to prevent undefined errors
    if (!layer.csLayers) {
       layer.csLayers = [];
    }

    // Add a CSW layer to map
    if (this.conf.cswrenderer && this.conf.cswrenderer.includes(layer.id)) {
      // Remove old existing layer
      if (this.layerExists(layer.id)) {
        this.csCSWService.rmLayer(layer);
        delete this.layerModelList[layer.id];
      }
      // Add layer
      this.csCSWService.addLayer(layer, param);
      this.cacheLayerModelList(layer.id, layer);

    // Add a WMS layer to map
    } else if (this.layerHandlerService.contains(layer, ResourceType.WMS)) {
      // Remove old existing layer
      if (this.layerExists(layer.id)) {
        this.csWMSService.rmLayer(layer);
        delete this.layerModelList[layer.id];
      }
      // Add layer
      this.csWMSService.addLayer(layer, param);
      this.cacheLayerModelList(layer.id, layer);

     // Add a WFS layer to map
     } else if (this.layerHandlerService.contains(layer, ResourceType.WFS)) {
       // FIXME this.csWFSService.addLayer(layer, param);
       // FIXME this.layerModelList[layer.id] = layer;

     // Add a WWW layer to map
     } else if (this.layerHandlerService.contains(layer, ResourceType.WWW)) {
       // FIXME this.csWWWService.addLayer(layer, param);
       // FIXME this.layerModelList[layer.id] = layer;

     } else if (this.layerHandlerService.contains(layer, ResourceType.IRIS)) {
      // Remove old existing layer
      if (this.layerExists(layer.id)) {
        this.csIrisService.rmLayer(layer);
        delete this.layerModelList[layer.id];
      }
      // Add layer
      this.csIrisService.addLayer(layer, param);
      this.cacheLayerModelList(layer.id, layer);

    } else {
      throw new Error('No Suitable service found');
    }
  }

  /**
   * Add new layer to layer model list
   * @param id layer id
   * @param layer layer
   */
  private cacheLayerModelList(id: string, layer: LayerModel) {
    this.layerModelList[layer.id] = layer;
    this.addLayerSubject.next(layer);
  }

   /**
    *  In the event we have custom layer that is handled outside olMapService, we will want to register that layer here so that
    *  it can be handled by the clicked event handler.
    *  this is to support custom layer renderer such as iris that uses kml
    */
   public appendToLayerModelList(layer) {
     this.cacheLayerModelList(layer.id, layer);
   }

  /**
   * Add layer to the map. taking a short cut by wrapping the csw in a layerModel
   * @param layer the layer to add to the map
   */
   public addCSWRecord(cswRecord: CSWRecordModel): void {
        const itemLayer = new LayerModel();
        itemLayer.cswRecords = [cswRecord];
        itemLayer['expanded'] = false;
        itemLayer.id = cswRecord.id;
        itemLayer.description = cswRecord.description;
        itemLayer.hidden = false;
        itemLayer.layerMode = 'NA';
        itemLayer.name = cswRecord.name;
        itemLayer.splitDirection = ImagerySplitDirection.NONE;
        try {
            this.addLayer(itemLayer, {});
        } catch (error) {
            throw error;
        }
   }

  /**
   * Remove layer from map
   * @param layer the layer to remove from the map
   */
  public removeLayer(layer: LayerModel): void {
      this.manageStateService.removeLayer(layer.id);
      if (this.conf.cswrenderer && this.conf.cswrenderer.includes(layer.id)) {
        this.csCSWService.rmLayer(layer);
      } else if (this.layerHandlerService.contains(layer, ResourceType.IRIS)) {
        this.csIrisService.rmLayer(layer);
      } else {
        this.csWMSService.rmLayer(layer);
      }
      delete this.layerModelList[layer.id];
  }

  /**
   * Retrieve the layer model given an id string
   * @param layerId layer's id string
   */
  public getLayerModel(layerId: string): LayerModel {
      if (this.layerModelList.hasOwnProperty(layerId)) {
          return this.layerModelList[layerId];
      }
      return null;
  }

  /**
   * Check if the layer denoted by layerId has been added to the map
   * @param layerId the ID of the layer to check for
   */
  public layerExists(layerId: string): boolean {
    if (layerId in this.layerModelList) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * Set the opacity of a layer
   * @param layerId the ID of the layer to change opacity
   * @param opacity the value of opacity between 0.0 and 1.0
   */
  public setLayerOpacity(layer: LayerModel, opacity: number) {
    if (this.conf.cswrenderer && this.conf.cswrenderer.includes(layer.id)) {
      this.csCSWService.setOpacity(layer, opacity);
    } else {
      this.csWMSService.setOpacity(layer, opacity);
    }
  }

  /**
   * Retrieve the active layer list
   */
  public getLayerModelList(): { [key: string]: LayerModel; } {
    return this.layerModelList;
  }

  public getAddLayerSubject(): Subject<LayerModel> {
    return this.addLayerSubject;
  }

  /**
   * Fit the map to the extent that is provided
   * @param extent An array of numbers representing an extent: [minx, miny, maxx, maxy]
   */
  public fitView(extent: [number, number, number, number]): void {
      // FIXME this.map.getMap().getView().fit(extent);
  }

  /**
   * Zoom the map in one level
   */
  public zoomMapIn(): void {
    // FIXME this.csMapObject.zoomIn();
  }

  /**
   * Zoom the map out one level
   */
  public zoomMapOut(): void {
    // FIXME this.csMapObject.zoomOut();
  }

  /**
   * DrawBound
   * @returns a observable object that triggers an event when the user have completed the task
   */
  public drawBound(): RectangleEditorObservable {
    return this.csMapObject.drawBox();
  }

  /**
    * Method for drawing a dot on the map.
    * @returns the layer vector on which the dot is drawn on. This provides a handle for the dot to be deleted
    */
  public drawDot(coord): olLayerVector {
    // FIXME return this.csMapObject.drawDot(coord);
    return null;
  }

  /**
  * Method for drawing a polygon on the map.
  * @returns the polygon coordinates string BS on which the polygon is drawn on.
  */
  public drawPolygon(): BehaviorSubject<olLayerVector> {
    // FIXME return this.csMapObject.drawPolygon();
    return null;
  }

  /**
   * remove a vector layer from the map
   * @param the vector layer to be removed
   */
  public removeVector(vector: olLayerVector) {
    // FIXME this.csMapObject.removeVector(vector);
  }

  /**
   * Return the extent of the overall map
   * @returns the map extent
   */
  public getMapExtent(): olExtent {
    // FIXME return this.csMapObject.getMapExtent();
    return null;
  }

  /**
   * Draw an extent on the map object
   * @param extent the extent to display on the map
   * @param duration (Optional) the length of time in milliseconds to display
   * the extent before it is removed. If not supplied the extent will not be removed.
   */
  public displayExtent(extent: olExtent, duration?: number) {
    // FIXME this.csMapObject.displayExtent(extent, duration);
  }

  /**
   * Call updateSize on map to handle scale changes
   */
  public updateSize() {
    // FIXME this.csMapObject.updateSize();
  }

  /**
   * Change the OL Map's basemap
   * @param baseMap the basemap's ID value (string)
   */
  public switchBaseMap(baseMap: string) {
    // this.csMapObject.switchBaseMap(baseMap);
  }


  /**
   * Create a list of base maps from the environment file
   */
  public createBaseMapLayers(): any[] {
    const me = this;
    const baseMapLayers: any[] = [];
    for (const layer of this.env.baseMapLayers) {
      if (layer.layerType === 'OSM') {
        baseMapLayers.push(
          new ProviderViewModel({
            name: layer.viewValue,
            iconUrl: buildModuleUrl('assets/cesium/Widgets/Images/ImageryProviders/openStreetMap.png'),
            tooltip: layer.tooltip,
            creationFunction() {
              return new OpenStreetMapImageryProvider({
                url: 'https://a.tile.openstreetmap.org/',
              });
            },
          })
        );
      } else if (layer.layerType === 'Bing' && this.env.hasOwnProperty('bingMapsKey') &&
                 this.env.bingMapsKey.trim() && this.env.bingMapsKey !== 'Bing_Maps_Key') {
        let bingMapsStyle = BingMapsStyle.AERIAL;
        let bingMapsIcon = '';
        switch (layer.value) {
          case 'Aerial':
            bingMapsStyle = BingMapsStyle.AERIAL;
            bingMapsIcon = 'bingAerial.png';
            break;
          case 'AerialWithLabels':
            bingMapsStyle = BingMapsStyle.AERIAL_WITH_LABELS;
            bingMapsIcon = 'bingAerialLabels.png';
            break;
          case 'Road':
          default:
            bingMapsStyle = BingMapsStyle.ROAD;
            bingMapsIcon = 'bingRoads.png';
            break;
        }
        baseMapLayers.push(
          new ProviderViewModel({
            name: layer.viewValue,
            iconUrl: buildModuleUrl('assets/cesium/Widgets/Images/ImageryProviders/' + bingMapsIcon),
            tooltip: layer.tooltip,
            creationFunction() {
              return new BingMapsImageryProvider({
                url: 'https://dev.virtualearth.net',
                key: me.env.bingMapsKey,
                mapStyle: bingMapsStyle,
                // defaultAlpha: 1.0,
              });
            },
          })
        );
      } else if (layer.layerType === 'ESRI') {
        const esriUrl =
          'https://services.arcgisonline.com/ArcGIS/rest/services/' + layer.value + '/MapServer';
        let esriIcon = '';
        switch (layer.value) {
          case 'World_Imagery':
            esriIcon = 'esriWorldImagery.png';
            break;
          case 'NatGeo_World_Map':
            esriIcon = 'esriNationalGeographic.png';
            break;
          case 'World_Street_Map':
            esriIcon = 'esriWorldStreetMap.png';
            break;
          // No provided icon
          case 'World_Terrain_Base':
            esriIcon = 'esriWorldTerrainBase.png';
            break;
          case 'World_Topo_Map':
            esriIcon = 'esriWorldTopoMap.png';
            break;
          // Only shows internal borders
          case 'Reference/World_Boundaries_and_Places':
            esriIcon = 'esriWorldBoundariesAndPlaces.png';
            break;
          case 'Canvas/World_Dark_Gray_Base':
            esriIcon = 'esriWorldDarkGrayBase.png';
            break;
          case 'Canvas/World_Light_Gray_Base':
            esriIcon = 'esriWorldLightGrayBase.png';
            break;
        }
        baseMapLayers.push(
          new ProviderViewModel({
            name: layer.viewValue,
            iconUrl: buildModuleUrl('assets/cesium/Widgets/Images/ImageryProviders/' + esriIcon),
            tooltip: layer.tooltip,
            creationFunction() {
              return new ArcGisMapServerImageryProvider({
                url: esriUrl,
              });
            },
          })
        );
      } else if (layer.layerType === 'NEII') {
        baseMapLayers.push(
          new ProviderViewModel({
            name: layer.viewValue,
            iconUrl: buildModuleUrl('assets/cesium/Widgets/Images/ImageryProviders/naturalEarthII.png'),
            tooltip: layer.tooltip,
            creationFunction() {
              return new TileMapServiceImageryProvider({
                url: buildModuleUrl('assets/cesium/Assets/Textures/NaturalEarthII'),
              });
            },
          })
        );
      }
    }
    return baseMapLayers;
  }

  /**
   * Set the direction of the split pane that the specified layer is to appear in
   * @param layer the layer to appear in the left, right or both split panes
   * @param splitDirection the direction the layer is to appear in (ImageryLayerSplitDirection.[LEFT|RIGHT|NONE])
   */
  public setLayerSplitDirection(layer: LayerModel, splitDirection: ImagerySplitDirection) {
    const viewer = this.map.getCesiumViewer();
    for (const cesiumLayer of layer.csLayers) {
      const layerIndex = viewer.imageryLayers.indexOf(cesiumLayer);
      const imageryLayer = viewer.imageryLayers.get(layerIndex);
      if (imageryLayer !== undefined) {
        imageryLayer.splitDirection = splitDirection;
      }
    }
  }

  /**
   * Is the map split shown?
   */
  public getSplitMapShown(): boolean {
    return this.splitMapShown;
  }

  /**
   * Set whether the map split is shown
   * @param splitMapShown set the map split shown to this value
   */
  public setSplitMapShown(splitMapShown: boolean) {
    this.splitMapShown = splitMapShown;
  }

}
